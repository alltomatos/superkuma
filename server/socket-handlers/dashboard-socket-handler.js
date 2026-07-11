const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const { requirePermission, requireResource, scopeFilter } = require("../security/authz");
const { teamIdLoader } = require("../security/team-id-loaders");
const { resolveTeamIdForCreate } = require("../security/actor-repository");
const { z } = require("zod");
const { validate } = require("../validation");

const WIDGET_KINDS = ["status_tile", "metric_gauge", "group_summary"];

const createDashboardSchema = z.object({
    title: z.string().min(1).max(255),
});

const dashboardIdSchema = z.object({
    id: z.number().int().positive(),
});

const saveDashboardSchema = z.object({
    id: z.number().int().positive(),
    title: z.string().min(1).max(255).optional(),
    widgets: z.array(
        z.object({
            monitorId: z.number().int().positive(),
            kind: z.enum(WIDGET_KINDS).default("status_tile"),
            sectionName: z.string().max(255).nullish(),
        })
    ),
});

/**
 * Fetch a dashboard's widgets, ordered for display, with the linked monitor's
 * name/type joined in so callers don't need a second round-trip per widget.
 * @param {number} dashboardId The dashboard id.
 * @returns {Promise<Array<object>>} The widget rows.
 */
async function getWidgets(dashboardId) {
    return R.getAll(
        `SELECT dw.id, dw.monitor_id AS monitorId, dw.kind, dw.section_name AS sectionName, dw.sort_order AS sortOrder,
                m.name AS monitorName, m.type AS monitorType
         FROM dashboard_widget dw
         LEFT JOIN monitor m ON m.id = dw.monitor_id
         WHERE dw.dashboard_id = ?
         ORDER BY dw.sort_order ASC, dw.id ASC`,
        [dashboardId]
    );
}

/**
 * Handlers for team dashboards (ADR-0016): an internal, always team-scoped
 * composition of widgets (status tiles / metric gauges / group rollups) over
 * existing monitors -- the RMM-style operational view, distinct from the
 * public Status Page.
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.dashboardSocketHandler = (socket) => {
    // List dashboards. Unlike notification_route there is no global/team_id=NULL
    // concept here -- a dashboard always belongs to exactly one team, so the
    // scope filter alone (no "OR ... IS NULL") is the complete visibility rule.
    socket.on("getDashboardList", async (callback) => {
        try {
            checkLogin(socket);

            const scoped = scopeFilter(socket.actor, { column: "d.team_id", permission: "dashboard:read" });
            const dashboards = await R.getAll(
                `SELECT d.id, d.team_id AS teamId, d.title, t.name AS teamName,
                        (SELECT COUNT(*) FROM dashboard_widget dw WHERE dw.dashboard_id = d.id) AS widgetCount
                 FROM dashboard d
                 LEFT JOIN team t ON t.id = d.team_id
                 WHERE ${scoped.clause}
                 ORDER BY d.id DESC`,
                scoped.params
            );

            callback({ ok: true, dashboardList: dashboards });
        } catch (e) {
            log.error("dashboard", e);
            callback({ ok: false, msg: e.message });
        }
    });

    // Fetch one dashboard with its full, ordered widget list.
    socket.on("getDashboard", async (input, callback) => {
        try {
            checkLogin(socket);

            const { id } = validate(dashboardIdSchema, input);
            await requireResource(socket.actor, "dashboard:read", "dashboard", id, teamIdLoader);

            const dashboard = await R.findOne("dashboard", "id = ?", [id]);
            if (!dashboard) {
                throw new Error("Dashboard not found.");
            }

            const widgets = await getWidgets(id);

            callback({
                ok: true,
                dashboard: { id: dashboard.id, teamId: dashboard.team_id, title: dashboard.title },
                widgets,
            });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Create an (initially empty) dashboard in the actor's active team. Team_id
    // is NEVER taken from client input (ADR-0016) -- resolved server-side from
    // the authenticated actor, same idiom as addMonitor/addTag
    // (monitor-socket-handler.js), not notification_route's client-chosen-team
    // idiom (which exists there only because a route may also target a
    // superadmin-only global scope, a case dashboards don't have).
    socket.on("createDashboard", async (input, callback) => {
        try {
            checkLogin(socket);

            const { title } = validate(createDashboardSchema, input);
            requirePermission(socket.actor, "dashboard:manage", {
                teamId: socket.actor ? socket.actor.activeTeamId : null,
            });

            const bean = R.dispense("dashboard");
            bean.team_id = await resolveTeamIdForCreate(socket.actor);
            bean.title = title;
            await R.store(bean);

            log.debug("dashboard", `Created dashboard ${bean.id} (team ${bean.team_id})`);

            callback({ ok: true, dashboardId: bean.id });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Replace a dashboard's full widget list (and optionally its title) --
    // same "save/replace" semantics as save_status_page's groups. Every
    // widget's monitorId is checked to belong to the SAME team as the
    // dashboard (requireResource against "monitor:read"), closing the same
    // cross-team-linking hole ADR-0010 R3 closed for updateMonitorNotification
    // and notification_route's monitor/tag links -- an agent cannot smuggle
    // another team's monitor onto this dashboard. All checks run BEFORE any
    // write, so a rejected widget never leaves the dashboard's existing
    // widgets half-deleted.
    socket.on("saveDashboard", async (input, callback) => {
        try {
            checkLogin(socket);

            const { id, title, widgets } = validate(saveDashboardSchema, input);
            await requireResource(socket.actor, "dashboard:manage", "dashboard", id, teamIdLoader);

            const dashboard = await R.findOne("dashboard", "id = ?", [id]);
            if (!dashboard) {
                throw new Error("Dashboard not found.");
            }

            for (const widget of widgets) {
                await requireResource(socket.actor, "monitor:read", "monitor", widget.monitorId, teamIdLoader);
            }

            if (title !== undefined) {
                dashboard.title = title;
                await R.store(dashboard);
            }

            await R.exec("DELETE FROM dashboard_widget WHERE dashboard_id = ?", [id]);
            for (let i = 0; i < widgets.length; i++) {
                const w = widgets[i];
                const bean = R.dispense("dashboard_widget");
                bean.dashboard_id = id;
                bean.monitor_id = w.monitorId;
                bean.kind = w.kind;
                bean.section_name = w.sectionName ?? null;
                bean.sort_order = i;
                await R.store(bean);
            }

            log.debug("dashboard", `Saved dashboard ${id} (${widgets.length} widget(s))`);

            callback({ ok: true, widgetCount: widgets.length });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Delete a dashboard (its widgets cascade via the DB FK). Permission is
    // checked against the row's OWN team_id (loaded fresh from the DB), never
    // from client input -- mirrors deleteNotificationRoute.
    socket.on("deleteDashboard", async (input, callback) => {
        try {
            checkLogin(socket);

            const { id } = validate(dashboardIdSchema, input);

            const dashboard = await R.findOne("dashboard", "id = ?", [id]);
            if (!dashboard) {
                throw new Error("Dashboard not found.");
            }

            requirePermission(socket.actor, "dashboard:manage", { teamId: dashboard.team_id });

            await R.trash(dashboard);

            log.debug("dashboard", `Deleted dashboard ${id}`);

            callback({ ok: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });
};
