const NotificationProvider = require("./notification-provider");
const axios = require("axios");

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

                await axios.post(url, data, config);
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
