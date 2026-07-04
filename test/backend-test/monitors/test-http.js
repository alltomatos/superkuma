const { describe, test } = require("node:test");
const assert = require("node:assert");
const { HttpMonitorType } = require("../../../server/monitor-types/http");
const { UP, PENDING } = require("../../../src/util");
const http = require("http");

describe("HTTP Monitor", () => {
    /**
     * Creates a minimal stub of the Monitor model exposing only what
     * HttpMonitorType#check() reads. Mirrors the plain-object style used by
     * test-tcp.js for TCPMonitorType.
     * @param {object} overrides Properties/methods to override on the stub
     * @returns {object} A monitor-like object literal
     */
    function makeMonitor(overrides = {}) {
        const url = overrides.url || "http://localhost:0/";
        return {
            name: "test-http-monitor",
            url,
            method: "get",
            timeout: 10,
            maxredirects: 10,
            type: "http",
            body: null,
            httpBodyEncoding: "json",
            headers: null,
            cacheBust: false,
            proxy_id: null,
            ipFamily: null,
            auth_method: null,
            tlsCert: null,
            tlsCa: null,
            tlsKey: null,
            keyword: "",
            jsonPath: null,
            jsonPathOperator: "==",
            expectedValue: null,
            getIgnoreTls: () => true,
            getAcceptedStatuscodes: () => ["200-299"],
            isInvertKeyword: () => false,
            getSaveResponse: () => false,
            getSaveErrorResponse: () => false,
            getUrl: () => {
                try {
                    return new URL(url);
                } catch (_) {
                    return null;
                }
            },
            handleTlsInfo: async () => {},
            makeAxiosRequest: async function (options) {
                const axios = require("axios");
                return axios.request(options);
            },
            ...overrides,
        };
    }

    /**
     * Creates a fresh heartbeat object literal in PENDING state.
     * @returns {object} A heartbeat-like object literal
     */
    function makeHeartbeat() {
        return {
            msg: "",
            status: PENDING,
        };
    }

    /**
     * Starts a plain Node http server on an ephemeral port with the given request handler.
     * @param {Function} handler (req, res) => void
     * @returns {Promise<{server: http.Server, port: number}>} the listening server and its port
     */
    async function startServer(handler) {
        return new Promise((resolve, reject) => {
            const server = http.createServer(handler);
            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
                resolve({ server, port: server.address().port });
            });
        });
    }

    /**
     * Closes a server and waits for it to fully release its handle.
     * @param {http.Server} server the server to close
     * @returns {Promise<void>}
     */
    async function closeServer(server) {
        return new Promise((resolve) => server.close(() => resolve()));
    }

    // ---------------------------------------------------------------
    // maxRedirects enforcement (GAP-009, part 1)
    // ---------------------------------------------------------------
    describe("maxRedirects enforcement", () => {
        /**
         * Starts a server that issues exactly `hops` sequential 302 redirects
         * (/, /r1, /r2, ... ) before finally responding 200 on the last hop.
         * @param {number} hops Number of redirect responses before the 200
         * @returns {Promise<{server: http.Server, port: number}>} the listening server and its port
         */
        async function startRedirectChainServer(hops) {
            return startServer((req, res) => {
                const match = /^\/r(\d+)$/.exec(req.url);
                const step = req.url === "/" ? 0 : match ? parseInt(match[1], 10) : -1;

                if (step === -1) {
                    res.writeHead(404);
                    res.end();
                    return;
                }

                if (step < hops) {
                    res.writeHead(302, { Location: `/r${step + 1}` });
                    res.end();
                } else {
                    res.writeHead(200, { "Content-Type": "text/plain" });
                    res.end("final destination");
                }
            });
        }

        test("check() throws 'Maximum number of redirects exceeded' when chain exceeds maxredirects", async () => {
            const hops = 3;
            const { server, port } = await startRedirectChainServer(hops);

            try {
                const httpMonitor = new HttpMonitorType();
                const monitor = makeMonitor({
                    url: `http://127.0.0.1:${port}/`,
                    maxredirects: hops - 1, // one hop short of the chain length
                });
                const heartbeat = makeHeartbeat();

                await assert.rejects(httpMonitor.check(monitor, heartbeat, {}), /Maximum number of redirects exceeded/);
            } finally {
                await closeServer(server);
            }
        });

        test("check() sets status to UP when maxredirects is high enough for the chain", async () => {
            const hops = 3;
            const { server, port } = await startRedirectChainServer(hops);

            try {
                const httpMonitor = new HttpMonitorType();
                const monitor = makeMonitor({
                    url: `http://127.0.0.1:${port}/`,
                    maxredirects: hops, // exactly enough
                });
                const heartbeat = makeHeartbeat();

                await httpMonitor.check(monitor, heartbeat, {});

                assert.strictEqual(heartbeat.status, UP);
            } finally {
                await closeServer(server);
            }
        });
    });

    // ---------------------------------------------------------------
    // Keyword match + inversion (GAP-009, part 2)
    // ---------------------------------------------------------------
    describe("keyword match and inversion", () => {
        /**
         * Starts a server that always responds 200 with a fixed body.
         * @param {string} body Response body text
         * @returns {Promise<{server: http.Server, port: number}>} the listening server and its port
         */
        async function startFixedBodyServer(body) {
            return startServer((req, res) => {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end(body);
            });
        }

        test("keyword present + not inverted -> UP", async () => {
            const { server, port } = await startFixedBodyServer("hello world, all is well");

            try {
                const httpMonitor = new HttpMonitorType();
                const monitor = makeMonitor({
                    url: `http://127.0.0.1:${port}/`,
                    type: "keyword",
                    keyword: "all is well",
                    isInvertKeyword: () => false,
                });
                const heartbeat = makeHeartbeat();

                await httpMonitor.check(monitor, heartbeat, {});

                assert.strictEqual(heartbeat.status, UP);
                assert.match(heartbeat.msg, /keyword is found/);
            } finally {
                await closeServer(server);
            }
        });

        test("keyword present + inverted -> throws/DOWN", async () => {
            const { server, port } = await startFixedBodyServer("hello world, all is well");

            try {
                const httpMonitor = new HttpMonitorType();
                const monitor = makeMonitor({
                    url: `http://127.0.0.1:${port}/`,
                    type: "keyword",
                    keyword: "all is well",
                    isInvertKeyword: () => true,
                });
                const heartbeat = makeHeartbeat();

                await assert.rejects(httpMonitor.check(monitor, heartbeat, {}), /keyword is present/);
            } finally {
                await closeServer(server);
            }
        });

        test("keyword absent + not inverted -> throws/DOWN", async () => {
            const { server, port } = await startFixedBodyServer("hello world, nothing to see here");

            try {
                const httpMonitor = new HttpMonitorType();
                const monitor = makeMonitor({
                    url: `http://127.0.0.1:${port}/`,
                    type: "keyword",
                    keyword: "all is well",
                    isInvertKeyword: () => false,
                });
                const heartbeat = makeHeartbeat();

                await assert.rejects(httpMonitor.check(monitor, heartbeat, {}), /but keyword is not in \[/);
            } finally {
                await closeServer(server);
            }
        });

        test("keyword absent + inverted -> UP", async () => {
            const { server, port } = await startFixedBodyServer("hello world, nothing to see here");

            try {
                const httpMonitor = new HttpMonitorType();
                const monitor = makeMonitor({
                    url: `http://127.0.0.1:${port}/`,
                    type: "keyword",
                    keyword: "all is well",
                    isInvertKeyword: () => true,
                });
                const heartbeat = makeHeartbeat();

                await httpMonitor.check(monitor, heartbeat, {});

                assert.strictEqual(heartbeat.status, UP);
                assert.match(heartbeat.msg, /keyword not found/);
            } finally {
                await closeServer(server);
            }
        });
    });

    // ---------------------------------------------------------------
    // json-query type
    // ---------------------------------------------------------------
    describe("json-query type", () => {
        /**
         * Starts a server that always responds 200 with a fixed JSON body.
         * @param {object} body Response body object, serialized as JSON
         * @returns {Promise<{server: http.Server, port: number}>} the listening server and its port
         */
        async function startJsonServer(body) {
            return startServer((req, res) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(body));
            });
        }

        test("passing comparison -> UP", async () => {
            const { server, port } = await startJsonServer({ status: "ok" });

            try {
                const httpMonitor = new HttpMonitorType();
                const monitor = makeMonitor({
                    url: `http://127.0.0.1:${port}/`,
                    type: "json-query",
                    jsonPath: "$.status",
                    jsonPathOperator: "==",
                    expectedValue: "ok",
                });
                const heartbeat = makeHeartbeat();

                await httpMonitor.check(monitor, heartbeat, {});

                assert.strictEqual(heartbeat.status, UP);
                assert.match(heartbeat.msg, /JSON query passes/);
            } finally {
                await closeServer(server);
            }
        });

        test("failing comparison -> throws/DOWN", async () => {
            const { server, port } = await startJsonServer({ status: "ok" });

            try {
                const httpMonitor = new HttpMonitorType();
                const monitor = makeMonitor({
                    url: `http://127.0.0.1:${port}/`,
                    type: "json-query",
                    jsonPath: "$.status",
                    jsonPathOperator: "==",
                    expectedValue: "down",
                });
                const heartbeat = makeHeartbeat();

                await assert.rejects(httpMonitor.check(monitor, heartbeat, {}), /JSON query does not pass/);
            } finally {
                await closeServer(server);
            }
        });
    });

    // ---------------------------------------------------------------
    // Basic auth header
    // ---------------------------------------------------------------
    describe("basic auth header", () => {
        test("sends 'Basic base64(user:pass)' Authorization header when auth_method is basic", async () => {
            let receivedAuthHeader = null;
            const { server, port } = await startServer((req, res) => {
                receivedAuthHeader = req.headers["authorization"];
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("ok");
            });

            try {
                const httpMonitor = new HttpMonitorType();
                const monitor = makeMonitor({
                    url: `http://127.0.0.1:${port}/`,
                    auth_method: "basic",
                    basic_auth_user: "myuser",
                    basic_auth_pass: "mypass",
                });
                const heartbeat = makeHeartbeat();

                await httpMonitor.check(monitor, heartbeat, {});

                assert.strictEqual(heartbeat.status, UP);
                const expected = "Basic " + Buffer.from("myuser:mypass").toString("base64");
                assert.strictEqual(receivedAuthHeader, expected);
            } finally {
                await closeServer(server);
            }
        });
    });

    // ---------------------------------------------------------------
    // Bearer auth header
    // ---------------------------------------------------------------
    describe("bearer auth header", () => {
        test("sends 'Bearer <token>' Authorization header when auth_method is bearer", async () => {
            let receivedAuthHeader = null;
            const { server, port } = await startServer((req, res) => {
                receivedAuthHeader = req.headers["authorization"];
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("ok");
            });

            try {
                const httpMonitor = new HttpMonitorType();
                const monitor = makeMonitor({
                    url: `http://127.0.0.1:${port}/`,
                    auth_method: "bearer",
                    bearer_token: "my-token-123",
                });
                const heartbeat = makeHeartbeat();

                await httpMonitor.check(monitor, heartbeat, {});

                assert.strictEqual(heartbeat.status, UP);
                assert.strictEqual(receivedAuthHeader, "Bearer my-token-123");
            } finally {
                await closeServer(server);
            }
        });
    });
});
