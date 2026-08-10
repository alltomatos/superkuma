/**
 * Shared helpers for registering MCP tools.
 *
 * Every tool is always registered -- the MCP server adds no authorization
 * surface of its own (ADR-0011). What an agent can actually do is decided
 * entirely by the API key's role: a call that exceeds the key's RBAC
 * permissions (Settings -> API Keys -> role) is rejected by the same
 * `checkLogin` + `requireResource` checks the dashboard itself goes through,
 * the same way a Viewer-role dashboard user can't click a delete button that
 * isn't there. Destructive tools still require `confirm: true` per call as a
 * mechanical safety net against a single mistaken invocation, independent of
 * who is authorized to make it.
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
 * Register a tool, wrapping the handler so any thrown error (including an
 * RBAC permission denial from the underlying SuperKuma call) becomes a clean
 * MCP error result instead of an uncaught exception.
 * @param {object} server The McpServer instance.
 * @param {object} config Resolved MCP configuration.
 * @param {object} spec Tool specification.
 * @param {string} spec.name Tool name.
 * @param {string} spec.title Human-readable title.
 * @param {string} spec.description Tool description.
 * @param {object} spec.inputSchema Zod raw shape for the tool input (optional).
 * @param {boolean} spec.mutation Whether the tool changes server state (optional; used for the
 *   `readOnlyHint` annotation shown to the MCP client, not for gating).
 * @param {boolean} spec.destructive Whether the tool deletes server state (optional; used for the
 *   `destructiveHint` annotation, not for gating).
 * @param {Function} spec.handler Async handler `(args) => data`.
 * @returns {boolean} Always true; kept for backward compatibility with callers checking the result.
 */
function registerTool(server, config, spec) {
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
