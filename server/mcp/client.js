const { io } = require("socket.io-client");

/**
 * Thin Socket.io client that authenticates to a running SuperKuma server with
 * an API key and exposes a promise-based {@link SuperKumaClient#request} plus a
 * live monitor cache. Every MCP tool talks to SuperKuma exclusively through this
 * wrapper, so it inherits SuperKuma's own `checkLogin`/RBAC authorization for
 * free (the MCP adds no new server-side authorization).
 */
class SuperKumaClient {
    /**
     * @param {object} config Resolved MCP configuration (see config.js).
     */
    constructor(config) {
        this.config = config;
        this.socket = null;
        this.loggedIn = false;

        /**
         * Live cache of monitors, keyed by monitor id. Kept in sync from the
         * server's push events exactly like the Vue dashboard does.
         * @type {{[key: string]: object}}
         */
        this.monitors = {};

        /**
         * Latest server "info" payload (version, primary base URL, etc.).
         * @type {object|null}
         */
        this.info = null;
    }

    /**
     * Connect to the server and authenticate with the API key. Resolves once the
     * session is authenticated; rejects on the first connection or auth failure.
     * Subsequent automatic reconnections re-authenticate transparently.
     * @returns {Promise<void>}
     * @throws {Error} If the connection or API-key login fails.
     */
    connect() {
        return new Promise((resolve, reject) => {
            let settled = false;

            const options = {
                reconnection: true,
                reconnectionDelay: 1000,
                timeout: this.config.requestTimeout,
                rejectUnauthorized: !this.config.insecureTls,
                transports: ["websocket"],
            };

            this.socket = io(this.config.url, options);

            this.registerListeners();

            this.socket.on("connect", async () => {
                try {
                    await this.loginByApiKey();
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                } catch (e) {
                    if (!settled) {
                        settled = true;
                        reject(e);
                    } else {
                        // A reconnect re-login failed; keep the process alive so the
                        // next reconnection attempt can retry. Log to stderr only.
                        process.stderr.write(`[superkuma-mcp] re-login failed: ${e.message}\n`);
                    }
                }
            });

            this.socket.on("connect_error", (err) => {
                if (!settled) {
                    settled = true;
                    reject(new Error(`Cannot connect to SuperKuma at ${this.config.url}: ${err.message}`));
                }
            });
        });
    }

    /**
     * Register the push-event listeners that keep the local caches fresh.
     * @returns {void}
     */
    registerListeners() {
        this.socket.on("monitorList", (list) => {
            this.monitors = list || {};
        });

        this.socket.on("updateMonitorIntoList", (list) => {
            Object.assign(this.monitors, list || {});
        });

        this.socket.on("deleteMonitorFromList", (monitorID) => {
            delete this.monitors[monitorID];
        });

        this.socket.on("info", (info) => {
            this.info = info || null;
        });
    }

    /**
     * Authenticate the current socket session using the configured API key via
     * the server's `loginByApiKey` event.
     * @returns {Promise<void>}
     * @throws {Error} If authentication fails or times out.
     */
    loginByApiKey() {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error("Timed out during API-key login"));
            }, this.config.requestTimeout);

            this.socket.emit("loginByApiKey", this.config.apiKey, (res) => {
                clearTimeout(timer);
                if (res && res.ok) {
                    this.loggedIn = true;
                    resolve();
                } else {
                    this.loggedIn = false;
                    const msg = res && res.msg ? res.msg : "unknown error";
                    reject(
                        new Error(
                            `API-key login rejected by server (${msg}). Check SUPERKUMA_API_KEY is valid, active and not expired.`
                        )
                    );
                }
            });
        });
    }

    /**
     * Emit a Socket.io event with an acknowledgement callback and resolve with
     * the server's response. Rejects if the server replies with `{ ok: false }`,
     * if the request times out, or if the socket is not connected.
     * @param {string} event The Socket.io event name.
     * @param {...any} args Positional arguments to send before the ack callback.
     * @returns {Promise<object>} The server acknowledgement payload.
     * @throws {Error} On a non-ok response, a timeout, or a disconnected socket.
     */
    request(event, ...args) {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.socket.connected) {
                reject(new Error("Not connected to SuperKuma."));
                return;
            }

            const timer = setTimeout(() => {
                reject(new Error(`Timed out waiting for a response to "${event}".`));
            }, this.config.requestTimeout);

            this.socket.emit(event, ...args, (res) => {
                clearTimeout(timer);
                if (res && res.ok === false) {
                    reject(new Error(res.msg || `"${event}" failed.`));
                } else {
                    resolve(res);
                }
            });
        });
    }

    /**
     * Return all monitors visible to the authenticated session. Forces a refresh
     * of the cache from the server before reading it.
     * @returns {Promise<Array<object>>} Array of monitor objects.
     * @throws {Error} If the refresh request fails.
     */
    async listMonitors() {
        await this.request("getMonitorList");
        return Object.values(this.monitors);
    }

    /**
     * Close the socket connection.
     * @returns {void}
     */
    close() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.loggedIn = false;
    }
}

module.exports = { SuperKumaClient };
