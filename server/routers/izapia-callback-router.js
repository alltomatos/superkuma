const express = require("express");
const axios = require("axios");
const { R } = require("redbean-node");
const { log } = require("../../src/util");
const { SuperKumaServer } = require("../superkuma-server");
const { verifySignature, extractButtonReplyId, extractQuotedReply } = require("../izapia-callback-helpers");
const { izapiaWebhookRateLimiter } = require("../rate-limiter");
const { resolveButtonLabels } = require("../notification-providers/izapia");

/**
 * Receives interactive-message webhook deliveries from IZAPIA (button clicks
 * on a "pause monitor" / "resume monitor" / "OK, ciente" notification sent by
 * server/notification-providers/izapia.js).
 *
 * Public-but-authenticated surface, same posture as `/api/push/:pushToken`
 * and the OTLP telemetry receiver: no `checkLogin`/session, authenticated
 * instead by an HMAC-SHA256 signature (`X-izapia-Signature: sha256=<hex>`)
 * over the raw request body, using the per-notification `izapiaWebhookSecret`
 * configured on the SuperKuma side and mirrored into the IZAPIA session's
 * webhook config (PUT /api/v1/sessions/{sid}/webhook).
 *
 * Two ways to recover which button was tapped, tried in order (see PR #91
 * for how this was worked out against a real IZAPIA session):
 *  1. `extractQuotedReply` -- the real path for a QR-paired (personal
 *     WhatsApp) session. A tap comes back as an ordinary text reply quoting
 *     the original message; `izapia_pending_action` (written by
 *     server/notification-providers/izapia.js at send time) maps that
 *     quoted message id back to a monitor/notification, and the reply TEXT
 *     (matched against the known button labels) supplies the action.
 *  2. `extractButtonReplyId` -- unverified fallback for a WhatsApp Business
 *     Cloud API session, where IZAPIA's docs say a tap is normalized into a
 *     `message.interactiveReply` event carrying the button's own `id`
 *     (`<action>:<monitorID>`, as sent).
 *
 * Either way, a clicked button can only ever affect a monitor that is
 * actually attached to the notification config whose secret verified the
 * request -- this is the authorization boundary (not a logged-in user), so
 * it is enforced via a `monitor_notification` join, not `checkOwner`.
 */

/**
 * Maps a button's label text to its action, matched against that
 * notification's OWN effective labels -- izapia.js's resolveButtonLabels()
 * falls back to the same defaults ("Pausar monitor", "Retomar monitor",
 * "OK, ciente") this used to hardcode, so a never-customized notification
 * still matches exactly as before; a customized one matches its own text.
 * @param {string} text Reply text (the tapped button's label).
 * @param {object} notificationConfig The matched notification's config.
 * @returns {?string} "pause" | "resume" | "ack", or null if unrecognized.
 */
function actionFromLabel(text, notificationConfig) {
    const normalized = (text || "").trim().toLowerCase();
    const labels = resolveButtonLabels(notificationConfig || {});
    if (normalized.includes(labels.pause.trim().toLowerCase())) {
        return "pause";
    }
    if (normalized.includes(labels.resume.trim().toLowerCase())) {
        return "resume";
    }
    if (normalized.includes(labels.ack.trim().toLowerCase())) {
        return "ack";
    }
    return null;
}

const router = express.Router();
const server = SuperKumaServer.getInstance();

const rawBodyParser = express.raw({ type: "*/*", limit: "256kb" });

router.post("/api/izapia/callback", rawBodyParser, async (request, response) => {
    try {
        // Rate-limited BEFORE the notification-table scan + HMAC compare below
        // (CodeQL: js/missing-rate-limiting) -- this is a public, unauthenticated-
        // until-verified endpoint, so an unbounded request rate would let an
        // attacker cheaply drive DB load regardless of whether their signature
        // ever verifies.
        const rateLimitOk = await izapiaWebhookRateLimiter.pass(null);
        if (!rateLimitOk) {
            return response.status(429).json({ ok: false, error: "Too many requests" });
        }

        const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
        let payload;
        try {
            payload = JSON.parse(rawBody.toString("utf-8") || "{}");
        } catch (e) {
            return response.status(400).json({ ok: false, error: "Invalid JSON body" });
        }

        const sid = payload.sid || payload.session_id || payload.data?.sid;
        const signatureHeader = request.get("X-izapia-Signature");

        // The `notification` table has no `type` column -- it only lives inside
        // the `config` JSON blob (see server/notification.js Notification.save()),
        // so filtering has to happen in JS after parsing each row.
        const candidates = await R.getAll("SELECT id, config FROM notification");
        let matchedNotification = null;
        for (const row of candidates) {
            let config;
            try {
                config = JSON.parse(row.config);
            } catch (e) {
                continue;
            }
            if (config.type !== "izapia" || config.izapiaSessionId !== sid) {
                continue;
            }
            if (verifySignature(config.izapiaWebhookSecret, rawBody, signatureHeader)) {
                matchedNotification = { id: row.id, config };
                break;
            }
        }

        if (!matchedNotification) {
            log.warn("izapia", "Rejected callback: no notification config matched sid + signature");
            return response.status(401).json({ ok: false, error: "Invalid signature" });
        }

        let action = null;
        let monitorID = null;
        let pendingActionRow = null;

        const quoted = extractQuotedReply(payload);
        if (quoted) {
            pendingActionRow = await R.getRow(
                "SELECT id, monitor_id FROM izapia_pending_action WHERE message_id = ? AND notification_id = ?",
                [quoted.quotedMessageId, matchedNotification.id]
            );
            if (pendingActionRow) {
                action = actionFromLabel(quoted.text, matchedNotification.config);
                monitorID = pendingActionRow.monitor_id;
            }
        }

        if (!action) {
            const replyId = extractButtonReplyId(payload);
            const match = replyId && replyId.match(/^(pause|resume|ack):(\d+)$/);
            if (match) {
                action = match[1];
                monitorID = parseInt(match[2], 10);
            }
        }

        if (!action || !monitorID) {
            // Not a button click we recognize (e.g. an unrelated message); ack and ignore.
            return response.json({ ok: true });
        }

        const link = await R.getRow("SELECT 1 FROM monitor_notification WHERE monitor_id = ? AND notification_id = ?", [
            monitorID,
            matchedNotification.id,
        ]);
        if (!link) {
            log.warn(
                "izapia",
                `Rejected callback: monitor ${monitorID} not attached to notification ${matchedNotification.id}`
            );
            return response.status(403).json({ ok: false, error: "Monitor not attached to this notification" });
        }

        if (pendingActionRow) {
            // One-shot: this specific button press has now been consumed.
            await R.exec("DELETE FROM izapia_pending_action WHERE id = ?", [pendingActionRow.id]);
        }

        let replyText = null;

        if (action === "pause") {
            await R.exec("UPDATE monitor SET active = 0 WHERE id = ?", [monitorID]);
            if (monitorID in server.monitorList) {
                await server.monitorList[monitorID].stop();
                server.monitorList[monitorID].active = 0;
            }
            replyText = `Monitor #${monitorID} pausado.`;
        } else if (action === "resume") {
            await R.exec("UPDATE monitor SET active = 1 WHERE id = ?", [monitorID]);
            let monitor = await R.findOne("monitor", " id = ? ", [monitorID]);
            if (monitor) {
                if (monitorID in server.monitorList) {
                    await server.monitorList[monitorID].stop();
                }
                server.monitorList[monitorID] = monitor;
                await monitor.start(server.io);
            }
            replyText = `Monitor #${monitorID} retomado.`;
        } else if (action === "ack") {
            log.info("izapia", `Notification ${matchedNotification.id} acked for monitor ${monitorID}`);
            replyText = "Recebido, obrigado.";
        }

        // Reply into the chat the tap came from (`data.chat`), not `data.from`
        // -- in a group, `from` is the tapping participant, not the chat itself.
        const replyTo = payload.data?.chat || payload.data?.from;

        if (replyText && replyTo) {
            try {
                const baseUrl = (matchedNotification.config.izapiaApiUrl || "https://api.izapia.com").replace(
                    /\/+$/,
                    ""
                );
                await axios.post(
                    `${baseUrl}/api/v1/sessions/${matchedNotification.config.izapiaSessionId}/messages/text`,
                    { to: replyTo, text: replyText },
                    {
                        headers: {
                            Accept: "application/json",
                            "Content-Type": "application/json",
                            Authorization: "Bearer " + matchedNotification.config.izapiaApiKey,
                        },
                    }
                );
            } catch (e) {
                log.warn("izapia", "Failed to send callback confirmation reply: " + e.message);
            }
        }

        return response.json({ ok: true });
    } catch (error) {
        log.error("izapia", "Callback handling failed: " + error.message);
        return response.status(500).json({ ok: false, error: "Internal error" });
    }
});

module.exports = router;
