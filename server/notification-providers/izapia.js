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
     * Creates a new WhatsApp session on IZAPIA, ready to be paired via QR
     * code (see requestPairingQr). Used by the dedicated iZapia settings
     * page's "create new connection" flow.
     * @param {object} config {izapiaApiKey} -- API key, not yet tied to a saved notification.
     * @param {string} name Optional human-readable session name (falsy to omit).
     * @returns {Promise<object>} The created session, e.g. {sid, name, ...}.
     * @throws {Error} If the API key is missing or the request fails.
     */
    static async createSession(config, name) {
        if (!config || !config.izapiaApiKey) {
            throw new Error("API Key is required to create a session.");
        }
        try {
            const response = await axios.post(
                `${Izapia.baseUrl(config)}/api/v1/sessions/`,
                name ? { name } : {},
                Izapia.authHeaders(config)
            );
            return response?.data?.data;
        } catch (error) {
            const provider = new Izapia();
            provider.throwGeneralAxiosError(error);
        }
    }

    /**
     * Lists the WhatsApp sessions available on the tenant's IZAPIA account,
     * for the "connect with existing connection" flow.
     * @param {object} config {izapiaApiKey} -- API key, not yet tied to a saved notification.
     * @returns {Promise<object[]>} Sessions as {sid, name, jid, status, ...}.
     * @throws {Error} If the API key is missing or the request fails.
     */
    static async listSessions(config) {
        if (!config || !config.izapiaApiKey) {
            throw new Error("API Key is required to list sessions.");
        }
        try {
            const response = await axios.get(`${Izapia.baseUrl(config)}/api/v1/sessions/`, Izapia.authHeaders(config));
            const sessions = response?.data?.data;
            return Array.isArray(sessions) ? sessions : [];
        } catch (error) {
            const provider = new Izapia();
            provider.throwGeneralAxiosError(error);
        }
    }

    /**
     * Fetches a single session's current status, used both right after
     * picking an existing connection and while polling for QR pairing to
     * complete.
     * @param {object} config {izapiaApiKey} -- API key, not yet tied to a saved notification.
     * @param {string} sid Session id.
     * @returns {Promise<object>} Session details, e.g. {sid, name, jid, status, ...}.
     * @throws {Error} If the API key/sid is missing or the request fails.
     */
    static async getSessionDetails(config, sid) {
        if (!config || !config.izapiaApiKey || !sid) {
            throw new Error("API Key and session id are required.");
        }
        try {
            const response = await axios.get(
                `${Izapia.baseUrl(config)}/api/v1/sessions/${sid}`,
                Izapia.authHeaders(config)
            );
            return response?.data?.data;
        } catch (error) {
            const provider = new Izapia();
            provider.throwGeneralAxiosError(error);
        }
    }

    /**
     * Requests a fresh pairing QR code for a session, to be scanned from the
     * WhatsApp app that should own this connection.
     * @param {object} config {izapiaApiKey} -- API key, not yet tied to a saved notification.
     * @param {string} sid Session id.
     * @returns {Promise<object>} {code, qr_png_base64}.
     * @throws {Error} If the API key/sid is missing or the request fails.
     */
    static async requestPairingQr(config, sid) {
        if (!config || !config.izapiaApiKey || !sid) {
            throw new Error("API Key and session id are required.");
        }
        try {
            const response = await axios.post(
                `${Izapia.baseUrl(config)}/api/v1/sessions/${sid}/pair`,
                {},
                Izapia.authHeaders(config)
            );
            return response?.data?.data;
        } catch (error) {
            const provider = new Izapia();
            provider.throwGeneralAxiosError(error);
        }
    }

    /**
     * Soft-disconnects a session (WhatsApp app unlinked, session row kept).
     * @param {object} config {izapiaApiKey} -- API key, not yet tied to a saved notification.
     * @param {string} sid Session id.
     * @returns {Promise<void>}
     * @throws {Error} If the API key/sid is missing or the request fails.
     */
    static async logoutSession(config, sid) {
        if (!config || !config.izapiaApiKey || !sid) {
            throw new Error("API Key and session id are required.");
        }
        try {
            await axios.post(`${Izapia.baseUrl(config)}/api/v1/sessions/${sid}/logout`, {}, Izapia.authHeaders(config));
        } catch (error) {
            const provider = new Izapia();
            provider.throwGeneralAxiosError(error);
        }
    }

    /**
     * Permanently deletes a session from the tenant's IZAPIA account.
     * @param {object} config {izapiaApiKey} -- API key, not yet tied to a saved notification.
     * @param {string} sid Session id.
     * @returns {Promise<void>}
     * @throws {Error} If the API key/sid is missing or the request fails.
     */
    static async deleteSession(config, sid) {
        if (!config || !config.izapiaApiKey || !sid) {
            throw new Error("API Key and session id are required.");
        }
        try {
            await axios.delete(`${Izapia.baseUrl(config)}/api/v1/sessions/${sid}`, Izapia.authHeaders(config));
        } catch (error) {
            const provider = new Izapia();
            provider.throwGeneralAxiosError(error);
        }
    }

    /**
     * Renames a session.
     * @param {object} config {izapiaApiKey} -- API key, not yet tied to a saved notification.
     * @param {string} sid Session id.
     * @param {string} name New session name.
     * @returns {Promise<void>}
     * @throws {Error} If the API key/sid/name is missing or the request fails.
     */
    static async renameSession(config, sid, name) {
        if (!config || !config.izapiaApiKey || !sid || !name) {
            throw new Error("API Key, session id and name are required.");
        }
        try {
            await axios.patch(`${Izapia.baseUrl(config)}/api/v1/sessions/${sid}`, { name }, Izapia.authHeaders(config));
        } catch (error) {
            const provider = new Izapia();
            provider.throwGeneralAxiosError(error);
        }
    }

    /**
     * The IZAPIA API always lives at api.izapia.com -- unlike other
     * providers, there is no per-tenant/self-hosted URL to configure.
     * @param {object} config Optionally {izapiaApiUrl} for legacy configs saved via the generic modal.
     * @returns {string} Base URL with no trailing slash.
     */
    static baseUrl(config) {
        return ((config && config.izapiaApiUrl) || "https://api.izapia.com").replace(/\/+$/, "");
    }

    /**
     * Shared axios config for authenticated session-management calls.
     * @param {object} config {izapiaApiKey}.
     * @returns {object} Axios request config with Authorization/Accept headers.
     */
    static authHeaders(config) {
        return {
            headers: {
                Accept: "application/json",
                Authorization: "Bearer " + config.izapiaApiKey,
            },
        };
    }

    /**
     * Builds the list of JIDs to send to, from either the current
     * multi-recipient fields (izapiaGroupIds/izapiaContacts) or -- for
     * notifications saved before that migration -- the legacy single
     * izapiaRecipient/izapiaRecipientType pair.
     * @param {object} notification Notification config.
     * @returns {string[]} JIDs to send to (may be empty).
     */
    resolveRecipients(notification) {
        const groupIds = Array.isArray(notification.izapiaGroupIds) ? notification.izapiaGroupIds : [];
        const contacts = Array.isArray(notification.izapiaContacts) ? notification.izapiaContacts : [];

        if (groupIds.length === 0 && contacts.length === 0 && notification.izapiaRecipient) {
            return [this.resolveJid(notification.izapiaRecipient, notification.izapiaRecipientType)];
        }

        return [
            ...groupIds.map((id) => this.resolveJid(id, "group")),
            ...contacts.map((contact) => this.resolveJid(contact, "contact")),
        ];
    }

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const recipients = this.resolveRecipients(notification);
        if (recipients.length === 0) {
            throw new Error("No recipients configured for this IZAPIA notification.");
        }

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
        const useInteractive = notification.izapiaEnableInteractive && monitorJSON && monitorJSON.id;

        const buttons = useInteractive
            ? [
                  monitorJSON.active
                      ? { id: `pause:${monitorJSON.id}`, kind: "quick_reply", label: "Pausar monitor" }
                      : { id: `resume:${monitorJSON.id}`, kind: "quick_reply", label: "Retomar monitor" },
                  { id: `ack:${monitorJSON.id}`, kind: "quick_reply", label: "OK, ciente" },
              ]
            : null;

        let sent = 0;
        let lastError = null;

        for (const to of recipients) {
            try {
                if (useInteractive) {
                    const url = `${baseUrl}/api/v1/sessions/${sid}/messages/interactive`;
                    const response = await axios.post(url, { to, body: msg, buttons }, config);
                    await this.recordPendingAction(response, notification, monitorJSON);
                } else {
                    const url = `${baseUrl}/api/v1/sessions/${sid}/messages/text`;
                    await axios.post(url, { to, text: msg }, config);
                }
                sent++;
            } catch (error) {
                lastError = error;
            }
        }

        if (sent === 0) {
            this.throwGeneralAxiosError(lastError);
        }

        const failed = recipients.length - sent;
        return failed > 0
            ? `Sent to ${sent}/${recipients.length} recipients (${failed} failed).`
            : "Sent Successfully.";
    }
}

module.exports = Izapia;
module.exports.extractMessageId = extractMessageId;
