/**
 * Embedded HTTP (Streamable HTTP) MCP endpoint.
 *
 * Exposes the SuperKuma MCP tools as a REMOTE MCP server hosted by the running
 * instance itself, so an AI client can connect to `https://<instance>/mcp`
 * instead of spawning the stdio server locally. Consume it via the `mcp-remote`
 * bridge, e.g.:
 *
 *   npx mcp-remote https://<instance>/mcp --header "Authorization:Bearer uk1_..."
 *
 * Authentication is per-request via the `Authorization: Bearer <api-key>`
 * header. The key is validated by opening a loopback Socket.io session against
 * this same server (`loginByApiKey`), so the endpoint reuses the exact auth +
 * RBAC scoping of the dashboard and adds no new authorization surface.
 *
 * Disabled by default: set `SUPERKUMA_MCP_HTTP_ENABLED=true` to serve it.
 */

const express = require("express");
const crypto = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { SuperKumaClient } = require("../mcp/client");
const { registerAllTools } = require("../mcp/tools");
const { loadGates } = require("../mcp/config");
const { localWebSocketURL } = require("../config");
const { log } = require("../../src/util");

const router = express.Router();

const MCP_SERVER_NAME = "superkuma-mcp";
const MCP_SERVER_VERSION = "0.1.0";

/**
 * Active MCP HTTP sessions keyed by the transport session id.
 * @type {Map<string, {transport: object, mcpServer: object, client: object}>}
 */
const sessions = new Map();

/**
 * Whether the embedded HTTP MCP endpoint is enabled via the environment.
 * @returns {boolean} True if enabled.
 */
function isEnabled() {
    const value = (process.env.SUPERKUMA_MCP_HTTP_ENABLED || "").trim().toLowerCase();
    return value === "true" || value === "1";
}

/**
 * Extract the Bearer API key from the Authorization header.
 * @param {express.Request} req Express request.
 * @returns {string|null} The API key, or null if absent/malformed.
 */
function getApiKey(req) {
    const auth = req.headers["authorization"] || "";
    const match = /^Bearer\s+(.+)$/i.exec(String(auth).trim());
    return match ? match[1].trim() : null;
}

/**
 * Build a JSON-RPC error body.
 * @param {number} code JSON-RPC error code.
 * @param {string} message Human-readable message.
 * @returns {object} The JSON-RPC error envelope.
 */
function jsonRpcError(code, message) {
    return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/**
 * Create a fresh MCP session (loopback client + McpServer + transport) for an
 * `initialize` request and handle it.
 * @param {express.Request} req Express request.
 * @param {express.Response} res Express response.
 * @returns {Promise<void>}
 */
async function createSession(req, res) {
    const apiKey = getApiKey(req);
    if (!apiKey) {
        res.status(401).json(jsonRpcError(-32001, "Missing 'Authorization: Bearer <api-key>' header."));
        return;
    }

    const gates = loadGates();
    const mcpConfig = {
        url: localWebSocketURL,
        apiKey,
        // Loopback connection to this same server; skip TLS verification for it.
        insecureTls: true,
        requestTimeout: gates.requestTimeout,
        allowMutations: gates.allowMutations,
        allowDelete: gates.allowDelete,
    };

    const client = new SuperKumaClient(mcpConfig);
    try {
        await client.connect();
    } catch (e) {
        client.close();
        res.status(401).json(jsonRpcError(-32001, "Unauthorized: " + e.message));
        return;
    }

    const mcpServer = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    registerAllTools(mcpServer, client, mcpConfig);

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, { transport, mcpServer, client });
            log.info("mcp", `HTTP MCP session started: ${sessionId}`);
        },
    });

    transport.onclose = () => {
        const sessionId = transport.sessionId;
        if (sessionId && sessions.has(sessionId)) {
            sessions.delete(sessionId);
            log.info("mcp", `HTTP MCP session closed: ${sessionId}`);
        }
        client.close();
        try {
            mcpServer.close();
        } catch (e) {
            // McpServer may already be closed; ignore.
        }
    };

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
}

/**
 * Handle a POST /mcp request (initialize or an in-session JSON-RPC call).
 * @param {express.Request} req Express request.
 * @param {express.Response} res Express response.
 * @returns {Promise<void>}
 */
async function handlePost(req, res) {
    const sessionId = req.headers["mcp-session-id"];
    const entry = sessionId ? sessions.get(String(sessionId)) : undefined;

    if (entry) {
        await entry.transport.handleRequest(req, res, req.body);
        return;
    }

    if (sessionId) {
        res.status(404).json(jsonRpcError(-32001, "Unknown or expired MCP session."));
        return;
    }

    // No session id -> must be an initialize request.
    await createSession(req, res);
}

/**
 * Handle GET (SSE stream) or DELETE (terminate) for an existing session.
 * @param {express.Request} req Express request.
 * @param {express.Response} res Express response.
 * @returns {Promise<void>}
 */
async function handleSessionRequest(req, res) {
    const sessionId = req.headers["mcp-session-id"];
    const entry = sessionId ? sessions.get(String(sessionId)) : undefined;
    if (!entry) {
        res.status(400).json(jsonRpcError(-32000, "Missing or invalid MCP session id."));
        return;
    }
    await entry.transport.handleRequest(req, res);
}

/**
 * Guard + error wrapper for the MCP route handlers.
 * @param {Function} handler The async handler.
 * @returns {Function} An Express handler.
 */
function guarded(handler) {
    return async (req, res) => {
        if (!isEnabled()) {
            res.status(404).json(
                jsonRpcError(-32601, "MCP HTTP endpoint is disabled (set SUPERKUMA_MCP_HTTP_ENABLED=true).")
            );
            return;
        }
        try {
            await handler(req, res);
        } catch (e) {
            log.error("mcp", "HTTP MCP request failed: " + e.message);
            if (!res.headersSent) {
                res.status(500).json(jsonRpcError(-32603, "Internal error: " + e.message));
            }
        }
    };
}

router.post("/mcp", guarded(handlePost));
router.get("/mcp", guarded(handleSessionRequest));
router.delete("/mcp", guarded(handleSessionRequest));

module.exports = router;
// Exposed for unit tests.
module.exports.getApiKey = getApiKey;
module.exports.isEnabled = isEnabled;
module.exports.jsonRpcError = jsonRpcError;
