const NotificationProvider = require("./notification-provider");
const axios = require("axios");
const { R } = require("redbean-node");

/**
 * Extracts the sent message's id from an IZAPIA API response. Every IZAPIA
 * response body is wrapped in a canonical envelope ({ok, data, error} -- see
 * the shared response schema in the OpenAPI), so the payload is at
 * response.data.data, one level deeper than a bare axios response usually
 * has it -- easy to miss (see PR #91: this exact mistake meant sent
 * messages were never recorded for interactive-button correlation).
 * @param {object} response Axios response from a /messages/* call.
 * @returns {?string} The message id, or null if not present.
 */
function extractMessageId(response) {
    const id = response?.data?.data?.message_id;
    return typeof id === "string" && id.length > 0 ? id : null;
}

class Izapia extends NotificationProvider {
    name = "izapia";

    /**
     * Normalizes a recipient into a WhatsApp JID based on its type.
     * @param {string} recipient Phone number, contact ID or group ID.
     * @param {string} recipientType "contact" or "group".
     * @returns {string} The JID to send the message to.
     */
    resolveJid(recipient, recipientType) {
        const value = (recipient || "").trim();
        if (value.includes("@")) {
            return value;
        }
        return recipientType === "group" ? `${value}@g.us` : `${value}@s.whatsapp.net`;
    }

    /**
     * Records which monitor/notification an outbound interactive message's
     * buttons belong to, keyed by the provider's own message id.
     *
     * A tapped button on a personal (QR-paired) WhatsApp session does NOT
     * come back as a structured reply carrying the button's `id` -- it comes
     * back as an ordinary text message quoting this one (confirmed live
     * against a real IZAPIA session). server/routers/izapia-callback-router.js
     * looks this row up by the quoted message id to recover which monitor
     * the reply is about; best-effort only (a storage failure here must not
     * fail the notification send itself).
     * @param {object} response Axios response from the /messages/interactive call.
     * @param {BeanModel} notification Notification config (needs its own row id).
     * @param {object} monitorJSON Monitor details.
     * @returns {Promise<void>}
     */
    async recordPendingAction(response, notification, monitorJSON) {
        const messageId = extractMessageId(response);
        if (!messageId || !notification.id || !monitorJSON || !monitorJSON.id) {
            return;
        }
        try {
            const bean = R.dispense("izapia_pending_action");
            bean.message_id = messageId;
            bean.monitor_id = monitorJSON.id;
            bean.notification_id = notification.id;
            await R.store(bean);
        } catch (e) {
            // Best-effort: a missing row just means this particular reply
            // won't be actionable, not a failed notification send.
        }
    }

    /**
     * Lists the WhatsApp groups visible to an IZAPIA session, for the "pick
     * a group" dropdown in the notification form (instead of the user
     * having to paste a raw group JID by hand).
     * @param {object} config {izapiaApiUrl, izapiaApiKey, izapiaSessionId} -- the
     * same fields the notification form itself collects, not yet saved.
     * @returns {Promise<{id: string, name: string}[]>} Groups as {id, name}.
     * @throws {Error} If the session id/API key are missing or the request fails.
     */
    static async listGroups(config) {
        if (!config || !config.izapiaSessionId || !config.izapiaApiKey) {
            throw new Error("Session ID and API Key are required to list groups.");
        }
        const baseUrl = (config.izapiaApiUrl || "https://api.izapia.com").replace(/\/+$/, "");
        try {
            const response = await axios.get(`${baseUrl}/api/v1/sessions/${config.izapiaSessionId}/groups`, {
                headers: {
                    Accept: "application/json",
                    Authorization: "Bearer " + config.izapiaApiKey,
                },
            });
            const groups = response?.data?.data;
            if (!Array.isArray(groups)) {
                return [];
            }
            return groups.map((group) => ({ id: group.group_id, name: group.subject || group.group_id }));
        } catch (error) {
            const provider = new Izapia();
            provider.throwGeneralAxiosError(error);
        }
    }

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            let config = {
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + notification.izapiaApiKey,
                },
            };
            config = this.getAxiosConfigWithProxy(config);

            const baseUrl = (notification.izapiaApiUrl || "https://api.izapia.com").replace(/\/+$/, "");
            const sid = notification.izapiaSessionId;
            const to = this.resolveJid(notification.izapiaRecipient, notification.izapiaRecipientType);

            if (notification.izapiaEnableInteractive && monitorJSON && monitorJSON.id) {
                const buttons = [
                    monitorJSON.active
                        ? { id: `pause:${monitorJSON.id}`, kind: "quick_reply", label: "Pausar monitor" }
                        : { id: `resume:${monitorJSON.id}`, kind: "quick_reply", label: "Retomar monitor" },
                    { id: `ack:${monitorJSON.id}`, kind: "quick_reply", label: "OK, ciente" },
                ];

                let url = `${baseUrl}/api/v1/sessions/${sid}/messages/interactive`;
                let data = {
                    to,
                    body: msg,
                    buttons,
                };

                const response = await axios.post(url, data, config);
                await this.recordPendingAction(response, notification, monitorJSON);
                return okMsg;
            }

            let url = `${baseUrl}/api/v1/sessions/${sid}/messages/text`;
            let data = {
                to,
                text: msg,
            };

            await axios.post(url, data, config);
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

module.exports = Izapia;
module.exports.extractMessageId = extractMessageId;
