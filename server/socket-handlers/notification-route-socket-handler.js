const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const { requirePermission, requireResource, scopeFilter, ForbiddenError } = require("../security/authz");
const { teamIdLoader } = require("../security/team-id-loaders");
const { SEVERITY_ORDER } = require("../notification-routing");
const { z } = require("zod");
const { validate } = require("../validation");

const createRouteSchema = z.object({
    teamId: z.number().int().positive().nullable(),
    minSeverity: z.enum(SEVERITY_ORDER),
    monitorId: z.number().int().positive().nullable().optional(),
    tagId: z.number().int().positive().nullable().optional(),
    notificationId: z.number().int().positive(),
});

const routeIdSchema = z.object({
    id: z.number().int().positive(),
});

/**
 * Whether a user is currently flagged as a global superadmin. Re-reads the DB
 * rather than trusting the cached socket.actor.isSuperadmin, mirroring
 * team-socket-handler.js's isSuperadmin() -- a global (team_id=null)
 * notification_route affects every tenant, so creating/deleting one is
 * reserved for a live superadmin, the same bar team creation uses.
 * @param {number} userId The user id to check
 * @returns {Promise<boolean>} True if the user is an active superadmin
 */
async function isSuperadmin(userId) {
    const caller = await R.findOne("user", "id = ?", [userId]);
    return !!(caller && caller.is_superadmin);
}

/**
 * Handlers for notification routing rules (ADR-0014): team-scoped (or global)
 * selectors that add extra notification targets to an alert beyond a
 * monitor's own statically-linked notification list.
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.notificationRouteSocketHandler = (socket) => {
    // List routes. A superadmin sees every route; anyone else sees routes for
    // teams they belong to (with notification:read), plus every global
    // (team_id=null) route -- those affect them too, even though only a
    // superadmin may create/delete one.
    socket.on("getNotificationRouteList", async (callback) => {
        try {
            checkLogin(socket);

            const scoped = scopeFilter(socket.actor, { column: "nr.team_id", permission: "notification:read" });
            const routes = await R.getAll(
                `SELECT nr.id, nr.team_id, nr.min_severity, nr.monitor_id, nr.tag_id, nr.notification_id,
                        t.name AS teamName, m.name AS monitorName, tg.name AS tagName, n.name AS notificationName
                 FROM notification_route nr
                 LEFT JOIN team t ON t.id = nr.team_id
                 LEFT JOIN monitor m ON m.id = nr.monitor_id
                 LEFT JOIN tag tg ON tg.id = nr.tag_id
                 LEFT JOIN notification n ON n.id = nr.notification_id
                 WHERE (${scoped.clause}) OR nr.team_id IS NULL
                 ORDER BY nr.id DESC`,
                scoped.params
            );

            callback({ ok: true, routeList: routes });
        } catch (e) {
            log.error("notification-route", e);
            callback({ ok: false, msg: e.message });
        }
    });

    // Create a route. A null teamId (global route) is superadmin-only, since
    // it fires for every tenant; a team-scoped route requires
    // notification:manage in that team. The linked monitor/tag/notification
    // (whichever are given) must themselves belong to the same team --
    // resolved server-side via requireResource, never trusted from the
    // client -- closing the same cross-team-linking hole ADR-0010 R3 closed
    // for updateMonitorNotification.
    socket.on("createNotificationRoute", async (input, callback) => {
        try {
            checkLogin(socket);

            const { teamId, minSeverity, monitorId, tagId, notificationId } = validate(createRouteSchema, input);

            if (teamId === null) {
                if (!(await isSuperadmin(socket.userID))) {
                    throw new ForbiddenError("Only a superadmin can create a global (all-teams) route.");
                }
            } else {
                requirePermission(socket.actor, "notification:manage", { teamId });
            }

            await requireResource(socket.actor, "notification:read", "notification", notificationId, teamIdLoader);
            if (monitorId != null) {
                await requireResource(socket.actor, "monitor:read", "monitor", monitorId, teamIdLoader);
            }
            if (tagId != null) {
                await requireResource(socket.actor, "tag:read", "tag", tagId, teamIdLoader);
            }

            let route = R.dispense("notification_route");
            route.team_id = teamId;
            route.min_severity = minSeverity;
            route.monitor_id = monitorId ?? null;
            route.tag_id = tagId ?? null;
            route.notification_id = notificationId;
            await R.store(route);

            log.debug("notification-route", `Created route ${route.id} (team ${teamId ?? "GLOBAL"})`);

            callback({ ok: true, msg: "notificationRouteCreated", msgi18n: true, routeId: route.id });
        } catch (e) {
            callback({ ok: false, msg: e.message, msgi18n: !!e.msgi18n });
        }
    });

    // Delete a route. Same authorization split as create: a global route
    // requires a live superadmin, a team-scoped route requires
    // notification:manage in its own team (resolved from the row itself via
    // teamIdLoader, never from client input).
    socket.on("deleteNotificationRoute", async (input, callback) => {
        try {
            checkLogin(socket);

            const { id } = validate(routeIdSchema, input);

            const route = await R.findOne("notification_route", "id = ?", [id]);
            if (!route) {
                throw new Error("Route not found.");
            }

            if (route.team_id === null) {
                if (!(await isSuperadmin(socket.userID))) {
                    throw new ForbiddenError("Only a superadmin can delete a global (all-teams) route.");
                }
            } else {
                requirePermission(socket.actor, "notification:manage", { teamId: route.team_id });
            }

            await R.trash(route);

            log.debug("notification-route", `Deleted route ${id}`);

            callback({ ok: true, msg: "notificationRouteDeleted", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message, msgi18n: !!e.msgi18n });
        }
    });
};
