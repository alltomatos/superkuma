const { registerInfoTools } = require("./info");
const { registerMonitorTools } = require("./monitors");
const { registerTagTools } = require("./tags");

/**
 * Register every MCP tool on the server. Individual tools self-gate on the
 * mutation/delete configuration, so this can be called unconditionally.
 * @param {object} server The McpServer instance.
 * @param {object} client The SuperKumaClient instance.
 * @param {object} config Resolved MCP configuration.
 * @returns {void}
 */
function registerAllTools(server, client, config) {
    registerInfoTools(server, client, config);
    registerMonitorTools(server, client, config);
    registerTagTools(server, client, config);
}

module.exports = { registerAllTools };
