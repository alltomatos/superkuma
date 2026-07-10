const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const { InfluxDbMonitorType } = require("../../../server/monitor-types/influxdb");
const { UP, PENDING } = require("../../../src/util");
const http = require("http");

describe("InfluxDB Monitor", () => {
    // A single shared server is started once and its behaviour is swapped per
    // test via `handler`. This avoids opening/closing an ephemeral-port server
    // per test, which is flaky on Windows loopback (connect ETIMEDOUT).
    let server;
    let baseUrl;
    let handler;
    // The most recent request the server received, for assertions.
    let lastRequest;

    before(async () => {
        await new Promise((resolve, reject) => {
            server = http.createServer((req, res) => {
                lastRequest = {
                    url: new URL(req.url, baseUrl),
                    headers: req.headers,
                };
                handler(req, res);
            });
            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    });

    after(async () => {
        await new Promise((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        lastRequest = null;
        // Default: a well-formed single-value response.
        handler = (req, res) => respondJson(res, 200, influxBody(4));
    });

    /**
     * Minimal stub of the Monitor model exposing only what InfluxDbMonitorType
     * #check() reads. Mirrors the plain-object style used by test-http.js /
     * test-tcp.js.
     * @param {object} overrides Properties to override on the stub
     * @returns {object} A monitor-like object literal
     */
    function makeMonitor(overrides = {}) {
        return {
            name: "test-influxdb-monitor",
            type: "influxdb",
            url: baseUrl,
            influxdbDatabase: "telegraf",
            databaseQuery: 'SELECT last("load1") FROM "system"',
            jsonPathOperator: "<=",
            expectedValue: "5",
            timeout: 10,
            interval: 60,
            ignoreTls: false,
            basic_auth_user: null,
            basic_auth_pass: null,
            bearer_token: null,
            ...overrides,
        };
    }

    /**
     * Fresh heartbeat literal in PENDING state.
     * @returns {object} A heartbeat-like object literal
     */
    function makeHeartbeat() {
        return {
            msg: "",
            status: PENDING,
            ping: undefined,
        };
    }

    /**
     * Write a JSON response with the given status code.
     * @param {http.ServerResponse} res The response object
     * @param {number} status HTTP status code
     * @param {object} body The JSON body to send
     * @returns {void}
     */
    function respondJson(res, status, body) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
    }

    /**
     * Build a well-formed InfluxQL /query JSON body for a single scalar value.
     * @param {number|string} value The value to return in the single series
     * @param {string} column The column name (defaults to "last")
     * @returns {object} An InfluxDB v1 response body
     */
    function influxBody(value, column = "last") {
        return {
            results: [
                {
                    statement_id: 0,
                    series: [
                        {
                            name: "system",
                            columns: ["time", column],
                            values: [[1720000000000, value]],
                        },
                    ],
                },
            ],
        };
    }

    test("check() returns UP when the condition passes (load1 4 <= 5)", async () => {
        handler = (req, res) => respondJson(res, 200, influxBody(4));

        const heartbeat = makeHeartbeat();
        await new InfluxDbMonitorType().check(makeMonitor(), heartbeat, null);

        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /condition passes/);
        assert.strictEqual(typeof heartbeat.ping, "number");
    });

    test("check() throws when the condition fails (load1 9 <= 5)", async () => {
        handler = (req, res) => respondJson(res, 200, influxBody(9));

        const heartbeat = makeHeartbeat();
        await assert.rejects(
            () => new InfluxDbMonitorType().check(makeMonitor(), heartbeat, null),
            /condition does not pass/
        );
        assert.notStrictEqual(heartbeat.status, UP);
    });

    test("check() sends db + q query params and the InfluxQL query", async () => {
        await new InfluxDbMonitorType().check(makeMonitor({ influxdbDatabase: "telegraf" }), makeHeartbeat(), null);

        assert.strictEqual(lastRequest.url.pathname, "/query");
        assert.strictEqual(lastRequest.url.searchParams.get("db"), "telegraf");
        assert.strictEqual(lastRequest.url.searchParams.get("q"), 'SELECT last("load1") FROM "system"');
    });

    test("check() sends Token auth (not Bearer) when a bearer_token is set", async () => {
        await new InfluxDbMonitorType().check(makeMonitor({ bearer_token: "s3cr3t" }), makeHeartbeat(), null);
        assert.strictEqual(lastRequest.headers["authorization"], "Token s3cr3t");
    });

    test("check() sends HTTP Basic auth when a username is set", async () => {
        await new InfluxDbMonitorType().check(
            makeMonitor({ basic_auth_user: "reader", basic_auth_pass: "pw" }),
            makeHeartbeat(),
            null
        );
        const expected = "Basic " + Buffer.from("reader:pw").toString("base64");
        assert.strictEqual(lastRequest.headers["authorization"], expected);
    });

    test("check() throws on an empty series (no data)", async () => {
        handler = (req, res) => respondJson(res, 200, { results: [{ statement_id: 0 }] });

        await assert.rejects(() => new InfluxDbMonitorType().check(makeMonitor(), makeHeartbeat(), null), /no data/);
    });

    test("check() throws with the InfluxDB error message on a bad query (HTTP 400)", async () => {
        handler = (req, res) => respondJson(res, 400, { error: "error parsing query: found FRM, expected FROM" });

        await assert.rejects(
            () => new InfluxDbMonitorType().check(makeMonitor(), makeHeartbeat(), null),
            /error parsing query/
        );
    });

    test("check() throws before any request when required fields are missing", async () => {
        // A handler that fails the test if it is ever reached.
        handler = () => assert.fail("check() should not have made a request with missing fields");

        await assert.rejects(
            () => new InfluxDbMonitorType().check(makeMonitor({ url: "" }), makeHeartbeat(), null),
            /URL is required/
        );
        await assert.rejects(
            () => new InfluxDbMonitorType().check(makeMonitor({ influxdbDatabase: "" }), makeHeartbeat(), null),
            /database is required/
        );
        await assert.rejects(
            () => new InfluxDbMonitorType().check(makeMonitor({ databaseQuery: "" }), makeHeartbeat(), null),
            /query is required/
        );
        assert.strictEqual(lastRequest, null);
    });
});
