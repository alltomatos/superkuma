/**
 * Configuration loader for the SuperKuma MCP server.
 *
 * All configuration comes from environment variables so the MCP process can be
 * spawned by any agent host (Claude Desktop, a local orchestrator, etc.) with a
 * plain env block. Nothing is read from the SuperKuma database or config files:
 * the MCP server is a pure Socket.io client of a running SuperKuma instance.
 */

/**
 * Parse a boolean-ish environment variable. Only "true"/"1" (case-insensitive)
 * enable the flag; everything else (including undefined) is false.
 * @param {string|undefined} value Raw environment value.
 * @returns {boolean} The parsed boolean.
 */
function parseBool(value) {
    if (typeof value !== "string") {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
}

/**
 * Parse a positive integer environment variable, falling back to a default.
 * @param {string|undefined} value Raw environment value.
 * @param {number} fallback Default to use when unset or invalid.
 * @returns {number} The parsed integer.
 */
function parseIntEnv(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/**
 * Load and validate the MCP configuration from the environment.
 * @returns {object} The resolved configuration object.
 * @throws {Error} If the required API key is missing.
 */
function loadConfig() {
    const url = (process.env.SUPERKUMA_URL || "http://localhost:3001").trim();
    const apiKey = (process.env.SUPERKUMA_API_KEY || "").trim();

    if (!apiKey) {
        throw new Error(
            "SUPERKUMA_API_KEY is required. Create an API key in SuperKuma " +
                "(Settings -> API Keys) and pass it as SUPERKUMA_API_KEY (format: uk<id>_<secret>)."
        );
    }

    return {
        url,
        apiKey,
        allowMutations: parseBool(process.env.SUPERKUMA_ALLOW_MUTATIONS),
        allowDelete: parseBool(process.env.SUPERKUMA_ALLOW_DELETE),
        insecureTls: parseBool(process.env.SUPERKUMA_INSECURE_TLS),
        requestTimeout: parseIntEnv(process.env.SUPERKUMA_REQUEST_TIMEOUT, 10000),
    };
}

module.exports = {
    loadConfig,
    parseBool,
    parseIntEnv,
};
