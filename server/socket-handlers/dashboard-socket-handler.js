const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const { requirePermission, requireResource, scopeFilter } = require("../security/authz");
const { teamIdLoader } = require("../security/team-id-loaders");
const { resolveTeamIdForCreate } = require("../security/actor-repository");
const { z } = require("zod");
const { validate } = require("../validation");

// Panel kinds (app-level enum, stored in dashboard_widget.kind). ADR-0016
// shipped the first three; ADR-0017 adds the richer Grafana-style panels.
const WIDGET_KINDS = ["status_tile", "metric_gauge", "group_summary", "stat", "speedometer", "trend", "pie"];

const slugSchema = z
    .string()
    .regex(/^[a-z0-9-]+$/, "Slug may only contain lowercase letters, numbers and hyphens.")
    .max(255);

const createDashboardSchema = z.object({
    title: z.string().min(1).max(255),
    slug: slugSchema.optional(),
    published: z.boolean().optional(),
});

const dashboardIdSchema = z.object({
    id: z.number().int().positive(),
});

const panelSchema = z.object({
    monitorId: z.number().int().positive(),
    kind: z.enum(WIDGET_KINDS).default("status_tile"),
    sectionName: z.string().max(255).nullish(),
    title: z.string().max(255).nullish(),
    posX: z.number().int().min(0).default(0),
    posY: z.number().int().min(0).default(0),
    width: z.number().int().min(1).max(12).default(4),
    height: z.number().int().min(1).max(100).default(4),
    config: z.record(z.string(), z.any()).nullish(),
});

const saveDashboardSchema = z.object({
    id: z.number().int().positive(),
    title: z.string().min(1).max(255).optional(),
    slug: slugSchema.optional(),
    published: z.boolean().optional(),
    description: z.string().max(10000).nullish(),
    refreshInterval: z.number().int().min(0).max(86400).optional(),
    theme: z.enum(["auto", "light", "dark"]).optional(),
    widgets: z.array(panelSchema),
});

/**
 * Slugify a dashboard title into the `[a-z0-9-]+` charset used by the public
 * route (same shape as `status_page` slugs and the ADR-0017 migration).
 * @param {string} title The dashboard title.
 * @returns {string} A slug fragment (never empty).
 */
function slugify(title) {
    const base = String(title || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
    return base || "dashboard";
}

/**
 * Ensure a slug is not already taken by a DIFFERENT dashboard. The slug is the
 * public URL key, so it must be globally unique (mirrors `status_page.slug`).
 * @param {string} slug The slug to check.
 * @param {number} exceptId A dashboard id to exclude (the one being edited), or 0/undefined.
 * @returns {Promise<void>}
 * @throws {Error} If the slug is already in use.
 */
async function assertSlugFree(slug, exceptId) {
    const existing = await R.findOne("dashboard", "slug = ? AND id != ?", [slug, exceptId || 0]);
    if (existing) {
        throw new Error("Dashboard slug already in use.");
    }
}

/**
 * Fetch a dashboard's panels, ordered for display, with the linked monitor's
 * name/type joined in so callers don't need a second round-trip per panel.
 * `config_json` is parsed back into a `config` object for consumers.
 * @param {number} dashboardId The dashboard id.
 * @returns {Promise<Array<object>>} The panel rows.
 */
async function getWidgets(dashboardId) {
    const rows = await R.getAll(
        `SELECT dw.id, dw.monitor_id AS monitorId, dw.kind, dw.section_name AS sectionName, dw.sort_order AS sortOrder,
                dw.title, dw.pos_x AS posX, dw.pos_y AS posY, dw.width, dw.height, dw.config_json AS configJson,
                m.name AS monitorName, m.type AS monitorType
         FROM dashboard_widget dw
         LEFT JOIN monitor m ON m.id = dw.monitor_id
         WHERE dw.dashboard_id = ?
         ORDER BY dw.sort_order ASC, dw.id ASC`,
        [dashboardId]
    );

    return rows.map((row) => {
        let config = null;
        if (row.configJson) {
            try {
                config = JSON.parse(row.configJson);
            } catch (e) {
                // A corrupt config_json must never break rendering the panel.
                log.warn("dashboard", `Ignoring unparseable config_json on panel ${row.id}: ${e.message}`);
            }
        }
        const { configJson, ...rest } = row;
        void configJson;
        return { ...rest, config };
    });
}

/**
 * Public, non-sensitive view of a dashboard row (no team internals beyond the
 * id) for both the authenticated getDashboard and the public route.
 * @param {object} dashboard A dashboard bean.
 * @returns {object} A plain dashboard summary.
 */
function toDashboardJSON(dashboard) {
    return {
        id: dashboard.id,
        teamId: dashboard.team_id,
        title: dashboard.title,
        slug: dashboard.slug,
        published: !!dashboard.published,
        description: dashboard.description ?? null,
        refreshInterval: dashboard.refresh_interval ?? 300,
        theme: dashboard.theme ?? "auto",
    };
}

module.exports.toDashboardJSON = toDashboardJSON;
module.exports.getWidgets = getWidgets;

/**
 * Handlers for team dashboards (ADR-0016 / ADR-0017): a team-scoped, Grafana-
 * style composition of positioned panels (gauges / stats / trends / pies /
 * group rollups) over existing monitors -- the RMM-style operational view. A
 * dashboard is internal by default and can be `published` to a public,
 * read-only `/dashboard/<slug>` route (ADR-0017 D3), distinct from the Status
 * Page. Editing is always gated by RBAC (`dashboard:read` / `dashboard:manage`).
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
                `SELECT d.id, d.team_id AS teamId, d.title, d.slug, d.published, t.name AS teamName,
                        (SELECT COUNT(*) FROM dashboard_widget dw WHERE dw.dashboard_id = d.id) AS widgetCount
                 FROM dashboard d
                 LEFT JOIN team t ON t.id = d.team_id
                 WHERE ${scoped.clause}
                 ORDER BY d.id DESC`,
                scoped.params
            );

            callback({
                ok: true,
                dashboardList: dashboards.map((d) => ({ ...d, published: !!d.published })),
            });
        } catch (e) {
            log.error("dashboard", e);
            callback({ ok: false, msg: e.message });
        }
    });

    // Fetch one dashboard with its full, ordered panel list.
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
                dashboard: toDashboardJSON(dashboard),
                widgets,
            });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Create an (initially empty) dashboard in the actor's active team. Team_id
    // is NEVER taken from client input (ADR-0016) -- resolved server-side from
    // the authenticated actor, same idiom as addMonitor/addTag
    // (monitor-socket-handler.js). A slug is auto-generated from the title when
    // not supplied; published defaults to false (never public until asked).
    socket.on("createDashboard", async (input, callback) => {
        try {
            checkLogin(socket);

            const { title, slug, published } = validate(createDashboardSchema, input);
            requirePermission(socket.actor, "dashboard:manage", {
                teamId: socket.actor ? socket.actor.activeTeamId : null,
            });

            if (slug) {
                await assertSlugFree(slug);
            }

            const bean = R.dispense("dashboard");
            bean.team_id = await resolveTeamIdForCreate(socket.actor);
            bean.title = title;
            bean.published = published ? 1 : 0;

            if (slug) {
                bean.slug = slug;
                await R.store(bean);
            } else {
                // No slug given: store to obtain the id, then derive a
                // globally-unique slug from the title + id (same rule the
                // ADR-0017 migration uses to backfill existing rows).
                await R.store(bean);
                bean.slug = `${slugify(title)}-${bean.id}`;
                await R.store(bean);
            }

            log.debug("dashboard", `Created dashboard ${bean.id} (team ${bean.team_id}, slug ${bean.slug})`);

            callback({ ok: true, dashboardId: bean.id, slug: bean.slug });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Replace a dashboard's full panel list (and optionally its title/slug/
    // published/description/refresh/theme) -- same "save/replace" semantics as
    // save_status_page's groups. Every panel's monitorId is checked to belong
    // to the SAME team as the dashboard (requireResource against "monitor:read"),
    // closing the same cross-team-linking hole ADR-0010 R3 closed. ALL authz +
    // uniqueness checks run BEFORE any write, so a rejected panel never leaves
    // the dashboard's existing panels half-deleted.
    socket.on("saveDashboard", async (input, callback) => {
        try {
            checkLogin(socket);

            const { id, title, slug, published, description, refreshInterval, theme, widgets } = validate(
                saveDashboardSchema,
                input
            );
            await requireResource(socket.actor, "dashboard:manage", "dashboard", id, teamIdLoader);

            const dashboard = await R.findOne("dashboard", "id = ?", [id]);
            if (!dashboard) {
                throw new Error("Dashboard not found.");
            }

            for (const widget of widgets) {
                await requireResource(socket.actor, "monitor:read", "monitor", widget.monitorId, teamIdLoader);
            }

            if (slug !== undefined) {
                await assertSlugFree(slug, id);
            }

            // Dashboard-level fields (all optional; storing unchanged is a no-op).
            if (title !== undefined) {
                dashboard.title = title;
            }
            if (slug !== undefined) {
                dashboard.slug = slug;
            }
            if (published !== undefined) {
                dashboard.published = published ? 1 : 0;
            }
            if (description !== undefined) {
                dashboard.description = description;
            }
            if (refreshInterval !== undefined) {
                dashboard.refresh_interval = refreshInterval;
            }
            if (theme !== undefined) {
                dashboard.theme = theme;
            }
            await R.store(dashboard);

            await R.exec("DELETE FROM dashboard_widget WHERE dashboard_id = ?", [id]);
            for (let i = 0; i < widgets.length; i++) {
                const w = widgets[i];
                const bean = R.dispense("dashboard_widget");
                bean.dashboard_id = id;
                bean.monitor_id = w.monitorId;
                bean.kind = w.kind;
                bean.section_name = w.sectionName ?? null;
                bean.title = w.title ?? null;
                bean.pos_x = w.posX;
                bean.pos_y = w.posY;
                bean.width = w.width;
                bean.height = w.height;
                bean.config_json = w.config ? JSON.stringify(w.config) : null;
                bean.sort_order = i;
                await R.store(bean);
            }

            log.debug("dashboard", `Saved dashboard ${id} (${widgets.length} panel(s))`);

            callback({ ok: true, widgetCount: widgets.length });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Delete a dashboard (its panels cascade via the DB FK). Permission is
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
