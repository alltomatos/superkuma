/**
 * Pure alert-routing logic (ADR-0014, TASK-A0-2). No I/O -- callers fetch the
 * candidate rows (static monitor_notification list, notification_route rows,
 * and the notification beans they point to) and pass them in as plain data.
 * Kept separate from server/model/monitor.js on purpose so the matching rules
 * are unit-testable without a database.
 */

/**
 * Severities ordered from least to most severe. A route's min_severity is a
 * threshold: the alert's severity must be at this position or later (i.e.
 * at least as severe) for the route to match.
 * @type {string[]}
 */
const SEVERITY_ORDER = ["info", "warning", "critical"];

/**
 * Whether an alert's severity meets (is at least as severe as) a route's
 * minimum severity threshold.
 * @param {string} alertSeverity The alert's own severity (e.g. monitor.alert_severity).
 * @param {string} minSeverity The route's min_severity selector.
 * @returns {boolean} True if alertSeverity is at or above minSeverity.
 * @throws {Error} If either severity is not one of SEVERITY_ORDER.
 */
function severityMeetsThreshold(alertSeverity, minSeverity) {
    const alertRank = SEVERITY_ORDER.indexOf(alertSeverity);
    const minRank = SEVERITY_ORDER.indexOf(minSeverity);

    if (alertRank === -1) {
        throw new Error(`Unknown alert severity: ${alertSeverity}`);
    }
    if (minRank === -1) {
        throw new Error(`Unknown route min_severity: ${minSeverity}`);
    }

    return alertRank >= minRank;
}

/**
 * Whether a notification_route row matches the given alert context. Every
 * selector field on the route is a constraint ONLY when non-null -- a null
 * team_id/monitor_id/tag_id is a wildcard for that dimension. All non-null
 * selectors must hold at once (conjunction), not just one of them.
 * @param {object} route A notification_route row (team_id/min_severity/monitor_id/tag_id/notification_id).
 * @param {object} context The alert context to match against.
 * @param {?number} context.teamId The monitor's team_id (null if the monitor has no team).
 * @param {number} context.monitorId The monitor's id.
 * @param {number[]} context.tagIds Tag ids currently attached to the monitor.
 * @param {string} context.severity The alert's severity.
 * @returns {boolean} True if this route should fire for this alert.
 */
function routeMatches(route, context) {
    if (route.team_id !== null && route.team_id !== context.teamId) {
        return false;
    }

    if (!severityMeetsThreshold(context.severity, route.min_severity)) {
        return false;
    }

    if (route.monitor_id !== null && route.monitor_id !== context.monitorId) {
        return false;
    }

    if (route.tag_id !== null && !context.tagIds.includes(route.tag_id)) {
        return false;
    }

    return true;
}

/**
 * Resolve the final, deduplicated list of notifications an alert should be
 * sent to: the legacy static list (monitor_notification), UNIONED with any
 * notification_route rows that match the given context. When routes is empty
 * (or none match), the result is exactly staticNotifications -- byte-identical
 * to the pre-ADR-0014 behavior of Monitor.getNotificationList().
 * @param {object} params Resolution inputs.
 * @param {Array<object>} params.staticNotifications Result of the legacy monitor_notification join (each with an `id`).
 * @param {Array<object>} params.routes Candidate notification_route rows already fetched for this monitor's team (plus global routes).
 * @param {Array<object>} params.allNotifications Notification bean rows (each with an `id`) to resolve a matching route's notification_id against.
 * @param {object} params.context The alert context -- see routeMatches().
 * @returns {Array<object>} The deduplicated notification list to send to.
 * @throws {Error} If a matching route points at a notification_id not present in allNotifications (data integrity issue upstream).
 */
function resolveNotificationTargets({ staticNotifications, routes, allNotifications, context }) {
    const byId = new Map();
    for (const notification of staticNotifications) {
        byId.set(notification.id, notification);
    }

    const notificationsById = new Map(allNotifications.map((n) => [n.id, n]));

    for (const route of routes) {
        if (!routeMatches(route, context)) {
            continue;
        }

        if (byId.has(route.notification_id)) {
            continue;
        }

        const notification = notificationsById.get(route.notification_id);
        if (!notification) {
            throw new Error(`notification_route ${route.id} points at unknown notification_id ${route.notification_id}`);
        }

        byId.set(notification.id, notification);
    }

    return Array.from(byId.values());
}

module.exports = {
    SEVERITY_ORDER,
    severityMeetsThreshold,
    routeMatches,
    resolveNotificationTargets,
};
