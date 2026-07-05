#!/usr/bin/env node

/**
 * SuperKuma MCP server entry point.
 *
 * Exposes SuperKuma configuration/monitoring to an AI agent over the Model
 * Context Protocol (stdio transport). It authenticates to a running SuperKuma
 * server with an API key and drives the existing Socket.io handlers, so it adds
 * no new authorization surface of its own.
 *
 * Configure via environment variables (see server/mcp/README.md):
 *   SUPERKUMA_URL, SUPERKUMA_API_KEY, SUPERKUMA_ALLOW_MUTATIONS,
 *   SUPERKUMA_ALLOW_DELETE, SUPERKUMA_INSECURE_TLS, SUPERKUMA_REQUEST_TIMEOUT
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { loadConfig } = require("./config");
const { SuperKumaClient } = require("./client");
const { registerAllTools } = require("./tools");

const MCP_SERVER_NAME = "superkuma-mcp";
const MCP_SERVER_VERSION = "0.1.0";

/**
 * Write a line to stderr. Under the stdio transport, stdout is reserved for the
 * MCP protocol, so all human-facing logging must go to stderr.
 * @param {string} message The message to log.
 * @returns {void}
 */
function logStderr(message) {
    process.stderr.write(`[${MCP_SERVER_NAME}] ${message}\n`);
}

/**
 * Boot the MCP server: load config, connect + authenticate to SuperKuma,
 * register the tools and start the stdio transport.
 * @returns {Promise<void>}
 * @throws {Error} If configuration is invalid or the connection fails.
 */
async function main() {
    const config = loadConfig();
    const client = new SuperKumaClient(config);

    logStderr(`connecting to ${config.url} ...`);
    await client.connect();
    logStderr(`authenticated (mutations=${config.allowMutations}, delete=${config.allowDelete})`);

    const server = new McpServer({
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
    });

    registerAllTools(server, client, config);

    const transport = new StdioServerTransport();
    await server.connect(transport);

    logStderr("ready (stdio transport)");

    /**
     * Gracefully close the SuperKuma connection and exit.
     * @returns {void}
     */
    const shutdown = () => {
        client.close();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((e) => {
    logStderr(`fatal: ${e.message}`);
    process.exit(1);
});
