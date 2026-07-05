const { registerTool } = require("./helpers");

/**
 * Register tag-related MCP tools. v1 exposes read access only; tag mutation
 * tools are planned for a later phase.
 * @param {object} server The McpServer instance.
 * @param {object} client The SuperKumaClient instance.
 * @param {object} config Resolved MCP configuration.
 * @returns {void}
 */
function registerTagTools(server, client, config) {
    registerTool(server, config, {
        name: "list_tags",
        title: "List tags",
        description: "List all tags defined in SuperKuma (id, name, color).",
        handler: async () => {
            const res = await client.request("getTags");
            return {
                count: (res.tags || []).length,
                tags: res.tags || [],
            };
        },
    });
}

module.exports = { registerTagTools };
