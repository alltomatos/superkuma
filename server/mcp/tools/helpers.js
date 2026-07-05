/**
 * Shared helpers for registering MCP tools.
 *
 * Tools are gated by the configuration: read-only tools are always registered;
 * mutating tools require `config.allowMutations`; destructive (delete) tools
 * additionally require `config.allowDelete`. This makes the MCP server safe by
 * default -- an agent can inspect but not change anything until writes are
 * explicitly opted into.
 */

/**
 * Build a successful MCP text result from a string or JSON-serialisable value.
 * @param {any} data String or value to return.
 * @returns {object} An MCP tool result.
 */
function textResult(data) {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return {
        content: [{ type: "text", text }],
    };
}

/**
 * Build an MCP error result.
 * @param {string} message Human-readable error message.
 * @returns {object} An MCP tool result flagged as an error.
 */
function errorResult(message) {
    return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
    };
}

/**
 * Register a tool while honouring the mutation/delete gates and wrapping the
 * handler so any thrown error becomes a clean MCP error result.
 * @param {object} server The McpServer instance.
 * @param {object} config Resolved MCP configuration.
 * @param {object} spec Tool specification.
 * @param {string} spec.name Tool name.
 * @param {string} spec.title Human-readable title.
 * @param {string} spec.description Tool description.
 * @param {object} spec.inputSchema Zod raw shape for the tool input (optional).
 * @param {boolean} spec.mutation Whether the tool changes server state (optional).
 * @param {boolean} spec.destructive Whether the tool deletes server state (optional).
 * @param {Function} spec.handler Async handler `(args) => data`.
 * @returns {boolean} True if the tool was registered, false if gated out.
 */
function registerTool(server, config, spec) {
    if (spec.mutation && !config.allowMutations) {
        return false;
    }
    if (spec.destructive && !config.allowDelete) {
        return false;
    }

    server.registerTool(
        spec.name,
        {
            title: spec.title,
            description: spec.description,
            inputSchema: spec.inputSchema || {},
            annotations: {
                readOnlyHint: !spec.mutation && !spec.destructive,
                destructiveHint: Boolean(spec.destructive),
            },
        },
        async (args) => {
            try {
                const data = await spec.handler(args || {});
                return textResult(data);
            } catch (e) {
                return errorResult(e.message);
            }
        }
    );

    return true;
}

module.exports = {
    textResult,
    errorResult,
    registerTool,
};
