const { z } = require("zod");
const { registerTool } = require("./helpers");

const WIDGET_KINDS = ["status_tile", "metric_gauge", "group_summary"];

/**
 * Register team-dashboard MCP tools (ADR-0016): read tools always; create/save
 * when mutations are enabled; delete when deletes are enabled. Dashboards are
 * always team-scoped -- team_id is resolved server-side from the API key's own
 * team, never accepted from the agent (the server enforces this regardless of
 * what this layer sends).
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
            "List dashboards visible to the authenticated API key (its own team's dashboards, or every team's for a superadmin key), as compact summaries (id, title, teamId, widgetCount).",
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
        description: "Fetch a dashboard's full, ordered widget list by id.",
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
            "Create a new, initially empty dashboard in the API key's own team. Use save_dashboard afterwards to add widgets.",
        mutation: true,
        inputSchema: {
            title: z.string().min(1).describe("Dashboard title"),
        },
        handler: async (args) => {
            const res = await client.request("createDashboard", { title: args.title });
            return {
                ok: true,
                dashboardId: res.dashboardId,
                message: `Created dashboard "${args.title}" (id ${res.dashboardId}).`,
            };
        },
    });

    registerTool(server, config, {
        name: "save_dashboard",
        title: "Save team dashboard widgets",
        description:
            "Replace a dashboard's full widget list (like editing it in the dashboard UI and hitting Save) -- " +
            "always pass every widget you want to keep, in the order you want them shown. Each widget references " +
            "an existing monitor id from the SAME team (use list_monitors with teamId to find them) and a kind: " +
            "'status_tile' (up/down + uptime), 'metric_gauge' (for numeric monitors like prometheus/influxdb/snmp " +
            "with a metricUnit -- reuses the same gauge as the monitor's own detail page), or 'group_summary' " +
            "(rollup of a monitor group's children). Optionally pass 'title' to rename the dashboard in the same call.",
        mutation: true,
        inputSchema: {
            id: z.number().int().describe("Dashboard id"),
            title: z.string().min(1).optional().describe("New title, if renaming"),
            widgets: z
                .array(
                    z.object({
                        monitorId: z.number().int().describe("Monitor id this widget displays"),
                        kind: z
                            .enum(WIDGET_KINDS)
                            .default("status_tile")
                            .describe("Widget type: status_tile, metric_gauge or group_summary"),
                        sectionName: z
                            .string()
                            .optional()
                            .describe("Optional section heading to group widgets under, e.g. 'Firewalls'"),
                    })
                )
                .describe("The complete ordered list of widgets, top to bottom"),
        },
        handler: async (args) => {
            const res = await client.request("saveDashboard", {
                id: args.id,
                title: args.title,
                widgets: args.widgets,
            });
            return {
                ok: true,
                message: `Saved dashboard ${args.id} with ${res.widgetCount} widget(s).`,
            };
        },
    });

    registerTool(server, config, {
        name: "delete_dashboard",
        title: "Delete team dashboard",
        description:
            "Permanently delete a dashboard (its widgets go with it). Destructive: requires the delete gate and confirm=true.",
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
