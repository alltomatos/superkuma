const { registerTool } = require("./helpers");

/**
 * Register informational/observability MCP tools.
 * @param {object} server The McpServer instance.
 * @param {object} client The SuperKumaClient instance.
 * @param {object} config Resolved MCP configuration.
 * @returns {void}
 */
function registerInfoTools(server, client, config) {
    registerTool(server, config, {
        name: "get_info",
        title: "Get server info",
        description:
            "Return the MCP connection status, which capabilities are enabled (mutations/deletes), the number of " +
            "visible monitors, the SuperKuma server info (version, base URL), and the team this connection is " +
            "scoped to (Teams/RBAC). Monitors created via create_monitor land in that team; every list tool " +
            "(list_monitors, etc.) only returns that team's resources once an instance has RBAC enforcement " +
            "turned on -- while it's off (the default), every resource is visible regardless of team.",
        handler: async () => {
            const info = client.info || {};
            return {
                connected: Boolean(client.socket && client.socket.connected),
                authenticated: client.loggedIn,
                url: config.url,
                mutationsEnabled: config.allowMutations,
                deleteEnabled: config.allowDelete,
                monitorCount: Object.keys(client.monitors).length,
                notificationCount: (client.notifications || []).length,
                statusPageCount: Object.keys(client.statusPages || {}).length,
                maintenanceCount: (Array.isArray(client.maintenances)
                    ? client.maintenances
                    : Object.keys(client.maintenances || {})
                ).length,
                team: (info.teams || []).find((t) => t.id === info.activeTeamId) || null,
                teams: info.teams || [],
                server: client.info,
            };
        },
    });
}

module.exports = { registerInfoTools };
