const { R } = require("redbean-node");

/**
 * Ensures a monitor_notification link exists (idempotent -- no-op if already
 * attached), used by both directions of IZAPIA's tag auto-attach.
 * @param {number} monitorID Monitor id.
 * @param {number} notificationID Notification id.
 * @returns {Promise<void>}
 */
async function ensureLink(monitorID, notificationID) {
    const existing = await R.getRow("SELECT 1 FROM monitor_notification WHERE monitor_id = ? AND notification_id = ?", [
        monitorID,
        notificationID,
    ]);
    if (!existing) {
        const link = R.dispense("monitor_notification");
        link.monitor_id = monitorID;
        link.notification_id = notificationID;
        await R.store(link);
    }
}

/**
 * Attaches an IZAPIA notification to every monitor that currently carries
 * its configured auto-attach tag (`config.izapiaAutoAttachTagId`). Called
 * right after a notification is saved, so tagging a monitor with that tag
 * BEFORE the notification exists still converges once the notification is
 * created/edited -- this is the "existing monitors" half; the other half
 * (a monitor tagged AFTER the notification exists) is handled by
 * attachTagNotificationsToMonitor(), called from the addMonitorTag socket
 * handler.
 * @param {number} notificationID Id of the just-saved notification.
 * @param {object} config Parsed notification config.
 * @returns {Promise<void>}
 */
async function attachNotificationToTaggedMonitors(notificationID, config) {
    if (config.type !== "izapia" || !config.izapiaAutoAttachTagId) {
        return;
    }
    const taggedMonitors = await R.getAll("SELECT monitor_id FROM monitor_tag WHERE tag_id = ?", [
        config.izapiaAutoAttachTagId,
    ]);
    for (const row of taggedMonitors) {
        await ensureLink(row.monitor_id, notificationID);
    }
}

/**
 * Attaches every IZAPIA notification configured with this tag as its
 * auto-attach tag to the monitor that just received the tag. Called from
 * the addMonitorTag socket handler (the single choke point both the UI and
 * the MCP addMonitorTag tool go through).
 * @param {number} tagID Id of the tag just attached to a monitor.
 * @param {number} monitorID Id of the monitor that received the tag.
 * @returns {Promise<void>}
 */
async function attachTagNotificationsToMonitor(tagID, monitorID) {
    const notifications = await R.getAll("SELECT id, config FROM notification WHERE active = 1");
    for (const row of notifications) {
        let config;
        try {
            config = JSON.parse(row.config);
        } catch (e) {
            continue;
        }
        if (config.type !== "izapia" || String(config.izapiaAutoAttachTagId) !== String(tagID)) {
            continue;
        }
        await ensureLink(monitorID, row.id);
    }
}

module.exports = { attachNotificationToTaggedMonitors, attachTagNotificationsToMonitor };
