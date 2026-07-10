process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server", "error_prometheus", "info_rate-limit"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");
const path = require("path");
const protobuf = require("protobufjs");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { Notification } = require("../../server/notification");
const { UP } = require("../../src/util");

// Same bootstrap workaround test-telemetry-router.js uses -- this standalone
// test file never goes through server.js's own bootstrap, which normally
// registers these dayjs plugins.
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

/**
 * ADR-0015 TASK-A2-4 hardening coverage for `POST /v1/metrics`
 * (server/routers/telemetry-router.js): OTLP/protobuf decoding, the
 * route-specific payload size cap, per-team rate limiting, and the
 * per-monitor cardinality cap.
 *
 * Two driving styles, deliberately:
 *   - Protobuf decoding and the payload-size cap are enforced by Express
 *     body-parser MIDDLEWARE that runs BEFORE the route handler function --
 *     calling the handler directly (test-telemetry-router.js's technique)
 *     would never exercise that middleware at all. Those tests spin up a
 *     REAL http.Server wrapping the actual, unmodified telemetry-router.js
 *     router and drive it with real HTTP requests (via the global `fetch`,
 *     no supertest dependency, same posture as the rest of this repo).
 *   - Rate limiting and the cardinality cap are handler-level logic, so
 *     they're driven the same direct-handler-invocation way
 *     test-telemetry-router.js already does (faster, no real sockets
 *     needed).
 */

/**
 * Locate and return the real handler function Express registered for
 * router.post("/v1/metrics", ...) -- the LAST entry in that route's
 * middleware stack (the two body-parser middlewares registered ahead of it,
 * TASK-A2-4, come first). See test-telemetry-router.js's own copy of this
 * helper for the same note.
 * @returns {Function} The real async (request, response) => {...} route handler.
 * @throws {Error} If the route can't be located.
 */
function extractTelemetryHandler() {
    const router = require("../../server/routers/telemetry-router.js");
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === "/v1/metrics") {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error('Could not locate router.post("/v1/metrics", ...) in telemetry-router.js\'s route stack');
}

/**
 * Build a minimal mock Express request carrying only what the telemetry
 * handler reads: request.headers.authorization and request.body. Same
 * shape as test-telemetry-router.js's makeReq() -- used only by the
 * direct-handler-invocation tests (rate limit, cardinality) in this file.
 * @param {?string} token Bearer token to send, or null/undefined to omit
 *     the Authorization header entirely.
 * @param {*} body Value for request.body (already "parsed").
 * @returns {object} Mock request.
 */
function makeReq(token, body) {
    const headers = {};
    if (token !== null && token !== undefined) {
        headers.authorization = `Bearer ${token}`;
    }
    return { headers, body };
}

/**
 * Build a minimal mock Express response capturing status()/json() calls.
 * @returns {{statusCode: number, body: (object|undefined), status: Function, json: Function}} Mock response.
 */
function makeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
}

let teamCounter = 0;

/**
 * Create a fresh, uniquely-slugged team with a given otel_ingest_token.
 * Each test uses its own team so tokens/monitors/rate-limiter buckets never
 * leak across tests sharing this file's one DB and one process (the
 * per-team rate limiter Map in telemetry-router.js is keyed by team.id and
 * lives for the whole test file's process lifetime).
 * @param {?string} otelIngestToken The team's ingest token.
 * @returns {Promise<object>} The stored team row (plain object, via knex).
 */
async function createTeam(otelIngestToken) {
    teamCounter += 1;
    const slug = `telemetry-hardening-team-${teamCounter}`;
    await R.knex("team").insert({
        name: slug,
        slug,
        is_system: false,
        active: true,
        otel_ingest_token: otelIngestToken ?? null,
    });
    return await R.knex("team").where("slug", slug).first();
}

/**
 * Dispense + store an otel-type Monitor bean, reloaded from the DB. Same
 * defaults/shape as test-telemetry-router.js's createOtelMonitor().
 * @param {number} teamId The owning team's id.
 * @param {object} fields Monitor fields to override.
 * @returns {Promise<import("../../server/model/monitor")>} The stored monitor bean.
 */
async function createOtelMonitor(teamId, fields = {}) {
    const bean = R.dispense("monitor");
    bean.import({
        name: "otel hardening test monitor",
        type: "otel",
        team_id: teamId,
        maxretries: 0,
        accepted_statuscodes_json: JSON.stringify(["200-299"]),
        conditions: "[]",
        kafkaProducerBrokers: "[]",
        kafkaProducerSaslOptions: "{}",
        rabbitmqNodes: "[]",
        otel_metric_name: "cpu.usage",
        otel_attribute_matchers: null,
        otel_aggregation: "last",
        jsonPath: "$",
        jsonPathOperator: "<",
        expectedValue: "90",
        ...fields,
    });
    await R.store(bean);
    return await R.load("monitor", bean.id);
}

/**
 * Fetch every heartbeat row stored for a monitor, most recent first.
 * @param {number} monitorId Monitor id.
 * @returns {Promise<Array<object>>} Heartbeat rows.
 */
async function heartbeatsFor(monitorId) {
    return await R.find("heartbeat", " monitor_id = ? ORDER BY id DESC", [monitorId]);
}

/**
 * Count ALL heartbeat rows in the table, regardless of monitor.
 * @returns {Promise<number>} Total heartbeat row count.
 */
async function countAllHeartbeats() {
    return await R.count("heartbeat", " 1 = 1 ");
}

/**
 * Build a minimal single-gauge-metric OTLP body (plain JS object, the same
 * shape used for both the OTLP/JSON path and as the source object handed to
 * protobufjs's fromObject()/encode() for the OTLP/protobuf path).
 * @param {object} options Datapoint construction options.
 * @param {string} options.metricName The metric name.
 * @param {number} options.value The datapoint's asDouble value.
 * @returns {object} The OTLP body (plain object).
 */
function buildOtlpBody(options) {
    return {
        resourceMetrics: [
            {
                resource: { attributes: [] },
                scopeMetrics: [
                    {
                        metrics: [
                            {
                                name: options.metricName,
                                gauge: {
                                    dataPoints: [{ attributes: [], asDouble: options.value }],
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

// Same schema the router itself loads -- reusing the real .proto file
// (rather than re-declaring a parallel copy here) guarantees this test
// encodes fixtures with the EXACT wire format the router's own decoder
// expects, catching any drift between "what we test" and "what ships".
const testProtoRoot = protobuf.loadSync(path.join(__dirname, "..", "..", "server", "otlp-proto", "metrics.proto"));
const TestExportMetricsServiceRequestType = testProtoRoot.lookupType(
    "superkuma.otlp.metrics.v1.ExportMetricsServiceRequest"
);

/**
 * Protobuf-encode an OTLP body (as built by buildOtlpBody()) into a Buffer,
 * using protobufjs's own encode() against the router's real .proto schema.
 * @param {object} otlpBody Plain-object OTLP body.
 * @returns {Buffer} The encoded ExportMetricsServiceRequest bytes.
 * @throws {Error} If otlpBody does not satisfy the ExportMetricsServiceRequest
 *     schema (a bug in the test fixture itself, not something under test).
 */
function encodeOtlpProtobuf(otlpBody) {
    const errMsg = TestExportMetricsServiceRequestType.verify(otlpBody);
    if (errMsg) {
        throw new Error(`Test fixture does not satisfy the OTLP proto schema: ${errMsg}`);
    }
    const message = TestExportMetricsServiceRequestType.fromObject(otlpBody);
    return Buffer.from(TestExportMetricsServiceRequestType.encode(message).finish());
}

describe("Telemetry router (POST /v1/metrics) hardening - ADR-0015 TASK-A2-4", () => {
    const testDb = new TestDB("./data/test-telemetry-router-hardening");
    let originalProviderList;
    let httpServer;
    let baseUrl;

    before(async () => {
        await testDb.create();

        originalProviderList = Notification.providerList;
        Notification.providerList = {
            "test-fake": {
                send: async () => "ok",
            },
        };

        // A REAL HTTP server wrapping the actual, unmodified
        // telemetry-router.js router -- needed so the route's
        // express.raw()/express.json() middlewares (TASK-A2-4) actually run,
        // which they do NOT when calling the handler function directly.
        const testApp = express();
        testApp.use(require("../../server/routers/telemetry-router.js"));
        httpServer = http.createServer(testApp);
        await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
        const { port } = httpServer.address();
        baseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        Notification.providerList = originalProviderList;
        Settings.stopCacheCleaner();
        await new Promise((resolve) => httpServer.close(resolve));
        await testDb.destroy();
    });

    describe("OTLP/protobuf", () => {
        test("a protobuf-encoded gauge datapoint round-trips through the real HTTP handler with the same outcome the equivalent JSON payload would", async () => {
            const jsonTeam = await createTeam("hardening-json-token");
            const jsonMonitor = await createOtelMonitor(jsonTeam.id, {
                name: "protobuf-parity-json-monitor",
                otel_metric_name: "cpu.usage",
                jsonPathOperator: "<",
                expectedValue: "90",
            });

            const protobufTeam = await createTeam("hardening-protobuf-token");
            const protobufMonitor = await createOtelMonitor(protobufTeam.id, {
                name: "protobuf-parity-protobuf-monitor",
                otel_metric_name: "cpu.usage",
                jsonPathOperator: "<",
                expectedValue: "90",
            });

            const body = buildOtlpBody({ metricName: "cpu.usage", value: 42.5 });

            const jsonRes = await fetch(`${baseUrl}/v1/metrics`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer hardening-json-token",
                },
                body: JSON.stringify(body),
            });
            assert.strictEqual(jsonRes.status, 200);
            assert.deepStrictEqual(await jsonRes.json(), {});

            const protobufBuffer = encodeOtlpProtobuf(body);
            const protobufRes = await fetch(`${baseUrl}/v1/metrics`, {
                method: "POST",
                headers: {
                    "content-type": "application/x-protobuf",
                    authorization: "Bearer hardening-protobuf-token",
                },
                body: protobufBuffer,
            });
            assert.strictEqual(protobufRes.status, 200);
            assert.deepStrictEqual(await protobufRes.json(), {});

            const jsonRows = await heartbeatsFor(jsonMonitor.id);
            const protobufRows = await heartbeatsFor(protobufMonitor.id);

            assert.strictEqual(jsonRows.length, 1);
            assert.strictEqual(protobufRows.length, 1);
            assert.strictEqual(jsonRows[0].status, UP);
            assert.strictEqual(protobufRows[0].status, UP);
            assert.strictEqual(jsonRows[0].ping, 42.5);
            assert.strictEqual(protobufRows[0].ping, 42.5);
        });

        test("an unparseable protobuf body -> 400, no heartbeat written", async () => {
            const team = await createTeam("hardening-malformed-protobuf-token");
            const monitor = await createOtelMonitor(team.id, { otel_metric_name: "cpu.usage" });
            const before = await countAllHeartbeats();

            const res = await fetch(`${baseUrl}/v1/metrics`, {
                method: "POST",
                headers: {
                    "content-type": "application/x-protobuf",
                    authorization: "Bearer hardening-malformed-protobuf-token",
                },
                // Not a valid protobuf wire encoding at all -- decode() must throw.
                body: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
            });

            assert.strictEqual(res.status, 400);
            const json = await res.json();
            assert.strictEqual(json.ok, false);
            assert.ok(typeof json.msg === "string" && json.msg.length > 0);
            assert.strictEqual(await countAllHeartbeats(), before);
            assert.strictEqual((await heartbeatsFor(monitor.id)).length, 0);
        });

        test("an unrecognized content-type still uses the OTLP/JSON path unchanged (today's implicit default)", async () => {
            const team = await createTeam("hardening-default-contenttype-token");
            const monitor = await createOtelMonitor(team.id, {
                otel_metric_name: "cpu.usage",
                jsonPathOperator: "<",
                expectedValue: "90",
            });

            // No content-type header at all -- neither body-parser's `type`
            // matcher matches, so request.body falls back to `{}`, and the
            // handler takes the (unchanged) OTLP/JSON branch, which then 400s
            // on the empty body exactly as it did before TASK-A2-4.
            const res = await fetch(`${baseUrl}/v1/metrics`, {
                method: "POST",
                headers: { authorization: "Bearer hardening-default-contenttype-token" },
                body: JSON.stringify(buildOtlpBody({ metricName: "cpu.usage", value: 42.5 })),
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual((await heartbeatsFor(monitor.id)).length, 0);
        });
    });

    describe("payload size limit", () => {
        test("a JSON body over the payload cap is rejected (413) by the body parser itself, before any monitor processing happens", async () => {
            const team = await createTeam("hardening-oversized-json-token");
            const monitor = await createOtelMonitor(team.id, { otel_metric_name: "cpu.usage" });
            const before = await countAllHeartbeats();

            // MAX_TELEMETRY_PAYLOAD_BYTES is 2MB -- pad well past it with an
            // otherwise well-formed (would-be-200) body.
            const oversizedBody = JSON.stringify({
                resourceMetrics: [],
                filler: "x".repeat(3 * 1024 * 1024),
            });
            assert.ok(Buffer.byteLength(oversizedBody) > 2 * 1024 * 1024, "sanity: fixture really is over 2MB");

            const res = await fetch(`${baseUrl}/v1/metrics`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer hardening-oversized-json-token",
                },
                body: oversizedBody,
            });

            assert.strictEqual(res.status, 413);
            assert.strictEqual(await countAllHeartbeats(), before, "no monitor processing must have happened at all");
            assert.strictEqual((await heartbeatsFor(monitor.id)).length, 0);
        });

        test("a protobuf body over the payload cap is rejected (413) by the body parser itself", async () => {
            const team = await createTeam("hardening-oversized-protobuf-token");
            await createOtelMonitor(team.id, { otel_metric_name: "cpu.usage" });
            const before = await countAllHeartbeats();

            const oversizedBuffer = Buffer.alloc(3 * 1024 * 1024, 0x01);

            const res = await fetch(`${baseUrl}/v1/metrics`, {
                method: "POST",
                headers: {
                    "content-type": "application/x-protobuf",
                    authorization: "Bearer hardening-oversized-protobuf-token",
                },
                body: oversizedBuffer,
            });

            assert.strictEqual(res.status, 413);
            assert.strictEqual(await countAllHeartbeats(), before);
        });

        test("a JSON body comfortably under the payload cap is accepted normally", async () => {
            const team = await createTeam("hardening-under-cap-token");
            const monitor = await createOtelMonitor(team.id, {
                otel_metric_name: "cpu.usage",
                jsonPathOperator: "<",
                expectedValue: "90",
            });

            const res = await fetch(`${baseUrl}/v1/metrics`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer hardening-under-cap-token",
                },
                body: JSON.stringify(buildOtlpBody({ metricName: "cpu.usage", value: 5 })),
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual((await heartbeatsFor(monitor.id)).length, 1);
        });
    });

    describe("per-team rate limit", () => {
        test("exceeding the per-team rate limit -> 429, and a DIFFERENT team is unaffected", async () => {
            const handler = extractTelemetryHandler();

            const busyTeam = await createTeam("hardening-ratelimit-busy-token");
            // No otel monitor for this team -- keeps each iteration cheap
            // (auth + rate-limit check only, no monitor matching/heartbeat
            // writes), since this test only cares about the auth/rate-limit
            // gate being exercised 121 times, not about monitor matching.
            const nonMatchingBody = buildOtlpBody({ metricName: "nothing.matches", value: 1 });

            // tokensPerInterval is 120/minute with fireImmediately: true (see
            // telemetry-router.js's getTelemetryRateLimiterForTeam()) -- the
            // bucket starts full, so 120 requests succeed and the 121st must
            // be rejected without any real waiting.
            let lastStatus;
            for (let i = 0; i < 121; i++) {
                const res = makeRes();
                await handler(makeReq("hardening-ratelimit-busy-token", nonMatchingBody), res);
                lastStatus = res.statusCode;
                if (i < 120) {
                    assert.strictEqual(lastStatus, 200, `request #${i + 1} (within the 120/min budget) should succeed`);
                }
            }
            assert.strictEqual(lastStatus, 429, "the 121st request must be rate-limited");

            const quietTeam = await createTeam("hardening-ratelimit-quiet-token");
            const quietRes = makeRes();
            await handler(makeReq("hardening-ratelimit-quiet-token", nonMatchingBody), quietRes);
            assert.strictEqual(
                quietRes.statusCode,
                200,
                "a DIFFERENT team must be completely unaffected by the busy team's exhausted bucket"
            );

            void busyTeam;
            void quietTeam;
        });

        test("a rate-limited response has the {ok:false, msg} shape", async () => {
            const handler = extractTelemetryHandler();
            await createTeam("hardening-ratelimit-shape-token");
            const nonMatchingBody = buildOtlpBody({ metricName: "nothing.matches", value: 1 });

            let res;
            for (let i = 0; i < 121; i++) {
                res = makeRes();
                await handler(makeReq("hardening-ratelimit-shape-token", nonMatchingBody), res);
            }

            assert.strictEqual(res.statusCode, 429);
            assert.strictEqual(res.body.ok, false);
            assert.ok(typeof res.body.msg === "string" && res.body.msg.length > 0);
        });
    });

    describe("cardinality cap", () => {
        test("a batch with more matched datapoints than the cap for one monitor is truncated (not rejected), still produces a valid aggregated result, and logs a warning", async () => {
            const handler = extractTelemetryHandler();
            const team = await createTeam("hardening-cardinality-token");
            const monitor = await createOtelMonitor(team.id, {
                name: "cardinality-cap-monitor",
                otel_metric_name: "cpu.usage",
                otel_aggregation: "avg",
                jsonPathOperator: "<",
                expectedValue: "1000000", // always UP -- this test is about the truncated VALUE, not the condition
            });

            // DEFAULT_MAX_MATCHED_DATAPOINTS_PER_MONITOR is 1000 -- 1005
            // values (1..1005) all matching the SAME monitor/metric in one
            // batch, generated programmatically rather than hand-typed.
            const dataPoints = Array.from({ length: 1005 }, (_, i) => ({
                attributes: [],
                asDouble: i + 1,
            }));
            const body = {
                resourceMetrics: [
                    {
                        resource: { attributes: [] },
                        scopeMetrics: [
                            {
                                metrics: [{ name: "cpu.usage", gauge: { dataPoints } }],
                            },
                        ],
                    },
                ],
            };

            const originalWarn = console.warn;
            const warnCalls = [];
            console.warn = (...args) => {
                warnCalls.push(args.join(" "));
            };

            let res;
            try {
                res = makeRes();
                await handler(makeReq("hardening-cardinality-token", body), res);
            } finally {
                console.warn = originalWarn;
            }

            assert.strictEqual(res.statusCode, 200, "the batch as a whole must still succeed, not be rejected");
            assert.deepStrictEqual(res.body, {});

            const rows = await heartbeatsFor(monitor.id);
            assert.strictEqual(rows.length, 1, "still exactly one heartbeat for this monitor, not one per datapoint");
            // avg(1..1000) -- truncated to the FIRST 1000 values in payload
            // order, per otel-selector.js's matchDatapointsToMonitors().
            assert.strictEqual(
                rows[0].ping,
                500.5,
                "aggregation must run over the truncated (first 1000), not all 1005, values"
            );

            assert.ok(
                warnCalls.some((line) => line.includes("truncated") && line.includes(monitor.name)),
                `expected a log.warn mentioning truncation and the monitor name, got: ${JSON.stringify(warnCalls)}`
            );
        });

        test("a batch AT exactly the cap is not truncated and does not warn", async () => {
            const handler = extractTelemetryHandler();
            const team = await createTeam("hardening-cardinality-at-cap-token");
            const monitor = await createOtelMonitor(team.id, {
                name: "cardinality-at-cap-monitor",
                otel_metric_name: "cpu.usage",
                otel_aggregation: "avg",
                jsonPathOperator: "<",
                expectedValue: "1000000",
            });

            const dataPoints = Array.from({ length: 1000 }, (_, i) => ({
                attributes: [],
                asDouble: i + 1,
            }));
            const body = {
                resourceMetrics: [
                    {
                        resource: { attributes: [] },
                        scopeMetrics: [{ metrics: [{ name: "cpu.usage", gauge: { dataPoints } }] }],
                    },
                ],
            };

            const originalWarn = console.warn;
            const warnCalls = [];
            console.warn = (...args) => {
                warnCalls.push(args.join(" "));
            };

            let res;
            try {
                res = makeRes();
                await handler(makeReq("hardening-cardinality-at-cap-token", body), res);
            } finally {
                console.warn = originalWarn;
            }

            assert.strictEqual(res.statusCode, 200);
            const rows = await heartbeatsFor(monitor.id);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].ping, 500.5, "avg(1..1000), nothing truncated");
            assert.strictEqual(warnCalls.length, 0, "exactly at the cap must NOT be treated as truncated");
        });
    });
});
