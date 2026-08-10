const express = require("express");
const axios = require("axios");
const { R } = require("redbean-node");
const { log } = require("../../src/util");
const { SuperKumaServer } = require("../superkuma-server");
const { verifySignature, extractButtonReplyId } = require("../izapia-callback-helpers");

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
 * The button `id` we send is `<action>:<monitorID>` (action = pause | resume
 * | ack). A clicked button can only ever affect a monitor that is actually
 * attached to the notification config whose secret verified the request --
 * this is the authorization boundary (not a logged-in user), so it is
 * enforced via a `monitor_notification` join, not `checkOwner`.
 */

const router = express.Router();
const server = SuperKumaServer.getInstance();

const rawBodyParser = express.raw({ type: "*/*", limit: "256kb" });

router.post("/api/izapia/callback", rawBodyParser, async (request, response) => {
    try {
        const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
        let payload;
        try {
            payload = JSON.parse(rawBody.toString("utf-8") || "{}");
        } catch (e) {
            return response.status(400).json({ ok: false, error: "Invalid JSON body" });
        }

        const sid = payload.sid || payload.session_id || payload.data?.sid;
        const signatureHeader = request.get("X-izapia-Signature");

        const candidates = await R.getAll("SELECT id, config FROM notification WHERE type = 'izapia'");
        let matchedNotification = null;
        for (const row of candidates) {
            let config;
            try {
                config = JSON.parse(row.config);
            } catch (e) {
                continue;
            }
            if (config.izapiaSessionId !== sid) {
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

        const replyId = extractButtonReplyId(payload);
        const match = replyId && replyId.match(/^(pause|resume|ack):(\d+)$/);
        if (!match) {
            // Not a button click we recognize (e.g. a plain text reply); ack and ignore.
            return response.json({ ok: true });
        }

        const [, action, monitorIDRaw] = match;
        const monitorID = parseInt(monitorIDRaw, 10);

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

        if (replyText && payload.from) {
            try {
                const baseUrl = (matchedNotification.config.izapiaApiUrl || "https://api.izapia.com").replace(
                    /\/+$/,
                    ""
                );
                await axios.post(
                    `${baseUrl}/api/v1/sessions/${matchedNotification.config.izapiaSessionId}/messages/text`,
                    { to: payload.from, text: replyText },
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
