const { z } = require("zod");
const { registerTool } = require("./helpers");

const WIDGET_KINDS = ["status_tile", "metric_gauge", "group_summary", "stat", "speedometer", "trend", "pie"];

/**
 * Register team-dashboard MCP tools (ADR-0016/ADR-0017): read tools always;
 * create/save when mutations are enabled; delete when deletes are enabled.
 * Dashboards are always team-scoped -- team_id is resolved server-side from
 * the API key's own team, never accepted from the agent (the server enforces
 * this regardless of what this layer sends).
 * @param {object} server The McpServer instance.
 * @param {object} client The SuperKumaClient instance.
 * @param {object} config Resolved MCP configuration.
 * @returns {void}
 */
function registerDashboardTools(server, client, config) {
    registerTool(server, config, {
        name: "list_dashboards",
        title: "List team dashboards",
        description:
            "List dashboards visible to the authenticated API key (its own team's dashboards, or every team's for a superadmin key), as compact summaries (id, title, slug, published, teamId, widgetCount).",
        handler: async () => {
            const res = await client.request("getDashboardList");
            return {
                count: res.dashboardList.length,
                dashboards: res.dashboardList,
            };
        },
    });

    registerTool(server, config, {
        name: "get_dashboard",
        title: "Get team dashboard",
        description:
            "Fetch a dashboard's full, ordered panel list by id, including each panel's kind, monitor, grid geometry (posX/posY/width/height) and config.",
        inputSchema: {
            id: z.number().int().describe("Dashboard id"),
        },
        handler: async (args) => {
            const res = await client.request("getDashboard", { id: args.id });
            return {
                dashboard: res.dashboard,
                widgets: res.widgets,
            };
        },
    });

    registerTool(server, config, {
        name: "create_dashboard",
        title: "Create team dashboard",
        description:
            "Create a new, initially empty dashboard in the API key's own team. Use save_dashboard afterwards to add panels. " +
            "A slug is auto-generated from the title if not given -- it becomes the public URL (/panel/<slug>) when the " +
            "dashboard is published. A dashboard is always created unpublished (internal-only) unless published=true is passed.",
        mutation: true,
        inputSchema: {
            title: z.string().min(1).describe("Dashboard title"),
            slug: z
                .string()
                .regex(/^[a-z0-9-]+$/)
                .optional()
                .describe(
                    "Optional explicit slug (lowercase letters/digits/hyphens only); auto-generated from the title if omitted"
                ),
            published: z
                .boolean()
                .optional()
                .describe(
                    "Whether the dashboard is publicly readable at /panel/<slug>. Defaults to false (internal-only)."
                ),
        },
        handler: async (args) => {
            const res = await client.request("createDashboard", {
                title: args.title,
                slug: args.slug,
                published: args.published,
            });
            return {
                ok: true,
                dashboardId: res.dashboardId,
                slug: res.slug,
                message: `Created dashboard "${args.title}" (id ${res.dashboardId}, slug "${res.slug}").`,
            };
        },
    });

    registerTool(server, config, {
        name: "save_dashboard",
        title: "Save team dashboard panels",
        description:
            "Replace a dashboard's full panel list (like editing it in the dashboard builder and hitting Save) -- " +
            "always pass every panel you want to keep, positioned on a 12-column grid. Each panel references an " +
            "existing monitor id from the SAME team (use list_monitors with teamId to find them) and a kind: " +
            "'status_tile' (up/down dot), 'metric_gauge' (arc gauge for numeric monitors like prometheus/influxdb/snmp), " +
            "'stat' (single large number), 'speedometer' (needle gauge, e.g. for NIC throughput -- config.max sets the ceiling), " +
            "'trend' (line chart of recent history, config.periodHours sets the window, default 6), 'pie' (up/down/pending " +
            "breakdown of a 'group'-type monitor's children), or 'group_summary' (the same breakdown as text counts). " +
            "Optionally pass 'title'/'slug'/'published'/'description'/'refreshInterval'/'theme' to update the dashboard's own fields in the same call.",
        mutation: true,
        inputSchema: {
            id: z.number().int().describe("Dashboard id"),
            title: z.string().min(1).optional().describe("New title, if renaming"),
            slug: z
                .string()
                .regex(/^[a-z0-9-]+$/)
                .optional()
                .describe(
                    "New slug (lowercase letters/digits/hyphens only) -- rejected if already used by another dashboard"
                ),
            published: z.boolean().optional().describe("Whether the dashboard is publicly readable at /panel/<slug>"),
            description: z.string().max(10000).nullish().describe("Optional description shown on the public view"),
            refreshInterval: z
                .number()
                .int()
                .min(0)
                .max(86400)
                .optional()
                .describe("Public view auto-refresh, in seconds"),
            theme: z.enum(["auto", "light", "dark"]).optional(),
            widgets: z
                .array(
                    z.object({
                        monitorId: z.number().int().describe("Monitor id this panel displays"),
                        kind: z
                            .enum(WIDGET_KINDS)
                            .default("status_tile")
                            .describe(
                                "Panel type: status_tile, metric_gauge, stat, speedometer, trend, pie or group_summary"
                            ),
                        title: z
                            .string()
                            .max(255)
                            .optional()
                            .describe("Optional panel title (defaults to the monitor's name)"),
                        posX: z.number().int().min(0).default(0).describe("Grid column (0-11)"),
                        posY: z.number().int().min(0).default(0).describe("Grid row"),
                        width: z.number().int().min(1).max(12).default(4).describe("Grid columns wide"),
                        height: z.number().int().min(1).default(4).describe("Grid rows tall"),
                        config: z
                            .record(z.string(), z.any())
                            .optional()
                            .describe(
                                "Panel-specific options, e.g. {unit, max} for speedometer/stat, {periodHours} for trend"
                            ),
                        sectionName: z
                            .string()
                            .optional()
                            .describe(
                                "Legacy ADR-0016 section heading; superseded by grid geometry, kept for compatibility"
                            ),
                    })
                )
                .describe("The complete panel list, each positioned on the grid"),
        },
        handler: async (args) => {
            const res = await client.request("saveDashboard", {
                id: args.id,
                title: args.title,
                slug: args.slug,
                published: args.published,
                description: args.description,
                refreshInterval: args.refreshInterval,
                theme: args.theme,
                widgets: args.widgets,
            });
            return {
                ok: true,
                message: `Saved dashboard ${args.id} with ${res.widgetCount} panel(s).`,
            };
        },
    });

    registerTool(server, config, {
        name: "delete_dashboard",
        title: "Delete team dashboard",
        description:
            "Permanently delete a dashboard (its panels go with it). Destructive: requires the delete gate and confirm=true.",
        mutation: true,
        destructive: true,
        inputSchema: {
            id: z.number().int().describe("Dashboard id"),
            confirm: z.boolean().describe("Must be true to actually delete. If false, returns a dry-run description."),
        },
        handler: async (args) => {
            if (!args.confirm) {
                return {
                    ok: false,
                    dryRun: true,
                    message: `Would delete dashboard ${args.id}. Re-run with confirm=true to proceed.`,
                };
            }
            await client.request("deleteDashboard", { id: args.id });
            return { ok: true, message: `Deleted dashboard ${args.id}.` };
        },
    });
}

module.exports = { registerDashboardTools };
