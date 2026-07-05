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
            "Return the MCP connection status, which capabilities are enabled (mutations/deletes), the number of visible monitors, and the SuperKuma server info (version, base URL).",
        handler: async () => {
            return {
                connected: Boolean(client.socket && client.socket.connected),
                authenticated: client.loggedIn,
                url: config.url,
                mutationsEnabled: config.allowMutations,
                deleteEnabled: config.allowDelete,
                monitorCount: Object.keys(client.monitors).length,
                notificationCount: (client.notifications || []).length,
                server: client.info,
            };
        },
    });
}

module.exports = { registerInfoTools };
