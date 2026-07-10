process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server", "error_prometheus"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { SuperKumaServer } = require("../../server/superkuma-server");
const { Notification } = require("../../server/notification");
const { UP, DOWN, MAINTENANCE } = require("../../src/util");

// bean.time is formatted via R.isoDateTimeMillis(dayjs.utc(...)) and parsed
// back the same way -- these plugins are normally registered by server.js's
// own bootstrap, which this standalone test file never requires. Same
// convention as test-api-push-endpoint.js / test-monitor-push-watchdog.js.
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

/**
 * Integration coverage for POST /v1/metrics (server/routers/telemetry-router.js,
 * ADR-0015 TASK-A2-2). Mirrors test-api-push-endpoint.js's technique of
 * reaching into the real express.Router() instance and pulling out the
 * actual registered handler, then driving it with hand-built mock req/res --
 * no supertest dependency in this repo.
 */

/**
 * Locate and return the real handler function Express registered for
 * router.post("/v1/metrics", ...) inside the express.Router() instance
 * exported by server/routers/telemetry-router.js.
 * @returns {Function} The real async (request, response) => {...} route handler.
 * @throws {Error} If the route can't be located (would mean the route
 *     path/registration changed).
 */
function extractTelemetryHandler() {
    const router = require("../../server/routers/telemetry-router.js");
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === "/v1/metrics") {
            return layer.route.stack[0].handle;
        }
    }
    throw new Error('Could not locate router.post("/v1/metrics", ...) in telemetry-router.js\'s route stack');
}

/**
 * Build a minimal mock Express request carrying only what the telemetry
 * handler reads: request.headers.authorization and request.body.
 * @param {?string} token Bearer token to send, or null/undefined to omit
 *     the Authorization header entirely.
 * @param {*} body Value for request.body (already "parsed", as if
 *     express.json() had already run).
 * @returns {object} Mock request
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
 * @returns {{statusCode: number, body: (object|undefined), status: Function, json: Function}} Mock response
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
 * Create a fresh, uniquely-slugged team with a given (or omitted)
 * otel_ingest_token. Each test uses its own team so tokens/monitors never
 * leak across tests sharing this file's one DB.
 * @param {?string} otelIngestToken The team's ingest token, or
 *     null/undefined to leave ingest disabled (dark by default).
 * @returns {Promise<object>} The stored team row (plain object, via knex).
 */
async function createTeam(otelIngestToken) {
    teamCounter += 1;
    const slug = `telemetry-test-team-${teamCounter}`;
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
 * Dispense + store an otel-type Monitor bean, reloaded from the DB so column
 * defaults SQLite applies at insert time are reflected in memory. Defaults to
 * a permissive selector (no attribute matchers) and a simple "value < 90"
 * threshold condition -- override per test as needed.
 * @param {number} teamId The owning team's id.
 * @param {object} fields Monitor fields to override (camelCase/snake_case,
 *     matching bean property names -- both work, see server/otel-selector.js).
 * @returns {Promise<import("../../server/model/monitor")>} The stored monitor bean
 */
async function createOtelMonitor(teamId, fields = {}) {
    const bean = R.dispense("monitor");
    bean.import({
        name: "otel test monitor",
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
 * @param {number} monitorId Monitor id
 * @returns {Promise<Array<object>>} Heartbeat rows
 */
async function heartbeatsFor(monitorId) {
    return await R.find("heartbeat", " monitor_id = ? ORDER BY id DESC", [monitorId]);
}

/**
 * Count ALL heartbeat rows in the table, regardless of monitor -- used by
 * the auth-failure tests to assert nothing anywhere was touched.
 * @returns {Promise<number>} Total heartbeat row count
 */
async function countAllHeartbeats() {
    return await R.count("heartbeat", " 1 = 1 ");
}

/**
 * Build a minimal single-gauge-metric OTLP/JSON ExportMetricsServiceRequest
 * body with one resourceMetrics/scopeMetrics/metrics entry.
 * @param {object} options Datapoint construction options.
 * @param {string} options.metricName The metric name.
 * @param {number} options.value The datapoint's asDouble value.
 * @param {?Array<object>} options.resourceAttributes Resource-level OTLP KeyValue array (optional).
 * @param {?Array<object>} options.dataPointAttributes Datapoint-level OTLP KeyValue array (optional).
 * @param {?string} options.shape "gauge" or "sum" (default "gauge", optional).
 * @returns {object} The OTLP/JSON body.
 */
function buildOtlpBody(options) {
    const shape = options.shape || "gauge";
    return {
        resourceMetrics: [
            {
                resource: { attributes: options.resourceAttributes || [] },
                scopeMetrics: [
                    {
                        scope: {},
                        metrics: [
                            {
                                name: options.metricName,
                                [shape]: {
                                    dataPoints: [
                                        {
                                            attributes: options.dataPointAttributes || [],
                                            timeUnixNano: "1234567890000000000",
                                            asDouble: options.value,
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

/**
 * Place a monitor under "manual"-strategy maintenance, mirroring
 * test-api-push-endpoint.js's putUnderMaintenance().
 * @param {number} monitorId Monitor id to place under maintenance
 * @returns {Promise<void>}
 */
async function putUnderMaintenance(monitorId) {
    const bean = R.dispense("maintenance");
    bean.title = "characterization maintenance window";
    bean.description = "always-on manual maintenance for telemetry router tests";
    bean.active = true;
    bean.strategy = "manual";
    await R.store(bean);
    await R.knex("monitor_maintenance").insert({ monitor_id: monitorId, maintenance_id: bean.id });
    SuperKumaServer.getInstance().maintenanceList[bean.id] = bean;
}

describe("Telemetry router (POST /v1/metrics) - ADR-0015 TASK-A2-2", () => {
    const testDb = new TestDB("./data/test-telemetry-router");
    let handler;
    let originalProviderList;

    before(async () => {
        await testDb.create();
        handler = extractTelemetryHandler();

        originalProviderList = Notification.providerList;
        Notification.providerList = {
            "test-fake": {
                send: async () => "ok",
            },
        };
    });

    after(async () => {
        Notification.providerList = originalProviderList;
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("sanity check: extractTelemetryHandler() returns the real, live handler function", () => {
        assert.strictEqual(typeof handler, "function");
    });

    describe("auth", () => {
        test("missing Authorization header -> 401, no monitor/heartbeat touched", async () => {
            const before = await countAllHeartbeats();
            const res = makeRes();
            await handler(makeReq(null, buildOtlpBody({ metricName: "cpu.usage", value: 1 })), res);

            assert.strictEqual(res.statusCode, 401);
            assert.deepStrictEqual(res.body, { ok: false, msg: "Missing or invalid Authorization token." });
            assert.strictEqual(await countAllHeartbeats(), before);
        });

        test("wrong/unknown token -> 401, no monitor/heartbeat touched", async () => {
            const team = await createTeam("correct-token");
            await createOtelMonitor(team.id);
            const before = await countAllHeartbeats();

            const res = makeRes();
            await handler(makeReq("wrong-token", buildOtlpBody({ metricName: "cpu.usage", value: 1 })), res);

            assert.strictEqual(res.statusCode, 401);
            assert.deepStrictEqual(res.body, { ok: false, msg: "Missing or invalid Authorization token." });
            assert.strictEqual(await countAllHeartbeats(), before);
        });

        test("a team with otel_ingest_token = NULL (dark by default) can never be matched by any token", async () => {
            const team = await createTeam(null);
            await createOtelMonitor(team.id);

            const res = makeRes();
            await handler(makeReq("", buildOtlpBody({ metricName: "cpu.usage", value: 1 })), res);

            assert.strictEqual(res.statusCode, 401);
        });
    });

    describe("no matching monitor", () => {
        test("valid token, payload matches no monitor -> 200 {}, zero heartbeats written anywhere", async () => {
            const team = await createTeam("no-match-token");
            await createOtelMonitor(team.id, { otel_metric_name: "cpu.usage" });
            const before = await countAllHeartbeats();

            const res = makeRes();
            await handler(makeReq("no-match-token", buildOtlpBody({ metricName: "memory.usage", value: 42 })), res);

            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, {});
            assert.strictEqual(await countAllHeartbeats(), before);
        });
    });

    describe("single gauge datapoint matching one monitor", () => {
        test("UP: value satisfies the jsonPath/jsonPathOperator/expectedValue condition", async () => {
            const team = await createTeam("gauge-up-token");
            const monitor = await createOtelMonitor(team.id, {
                name: "gauge-up-monitor",
                otel_metric_name: "cpu.usage",
                jsonPathOperator: "<",
                expectedValue: "90",
            });

            const res = makeRes();
            await handler(makeReq("gauge-up-token", buildOtlpBody({ metricName: "cpu.usage", value: 42.5 })), res);

            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, {});

            const rows = await heartbeatsFor(monitor.id);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].status, UP);
            assert.strictEqual(rows[0].ping, 42.5);
        });

        test("DOWN: value fails the condition", async () => {
            const team = await createTeam("gauge-down-token");
            const monitor = await createOtelMonitor(team.id, {
                name: "gauge-down-monitor",
                otel_metric_name: "cpu.usage",
                jsonPathOperator: "<",
                expectedValue: "90",
            });

            const res = makeRes();
            await handler(makeReq("gauge-down-token", buildOtlpBody({ metricName: "cpu.usage", value: 99.9 })), res);

            assert.strictEqual(res.statusCode, 200);
            const rows = await heartbeatsFor(monitor.id);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].status, DOWN);
            assert.strictEqual(rows[0].ping, 99.9);
        });
    });

    describe("sum-type metric", () => {
        test("a sum datapoint (not just gauge) is matched, evaluated, and stored the same way", async () => {
            const team = await createTeam("sum-token");
            const monitor = await createOtelMonitor(team.id, {
                name: "sum-monitor",
                otel_metric_name: "requests.errors",
                jsonPathOperator: "<",
                expectedValue: "10",
            });

            const res = makeRes();
            await handler(
                makeReq("sum-token", buildOtlpBody({ metricName: "requests.errors", value: 3, shape: "sum" })),
                res
            );

            assert.strictEqual(res.statusCode, 200);
            const rows = await heartbeatsFor(monitor.id);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].status, UP);
            assert.strictEqual(rows[0].ping, 3);
        });
    });

    describe("aggregation across multiple matched datapoints in one batch", () => {
        test("otel_aggregation = 'avg' averages every matched datapoint's value", async () => {
            const team = await createTeam("avg-token");
            const monitor = await createOtelMonitor(team.id, {
                name: "avg-monitor",
                otel_metric_name: "cpu.usage",
                otel_aggregation: "avg",
                jsonPathOperator: "<",
                expectedValue: "1000", // always UP -- this test is about the aggregated VALUE
            });

            const body = {
                resourceMetrics: [
                    {
                        resource: { attributes: [] },
                        scopeMetrics: [
                            {
                                scope: {},
                                metrics: [
                                    {
                                        name: "cpu.usage",
                                        gauge: {
                                            dataPoints: [
                                                { attributes: [], asDouble: 10 },
                                                { attributes: [], asDouble: 20 },
                                                { attributes: [], asDouble: 30 },
                                            ],
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            };

            const res = makeRes();
            await handler(makeReq("avg-token", body), res);

            assert.strictEqual(res.statusCode, 200);
            const rows = await heartbeatsFor(monitor.id);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].ping, 20); // (10+20+30)/3
        });

        test("otel_aggregation = 'last' takes the last matched datapoint in payload order (not sorted/time order)", async () => {
            const team = await createTeam("last-token");
            const monitor = await createOtelMonitor(team.id, {
                name: "last-monitor",
                otel_metric_name: "cpu.usage",
                otel_aggregation: "last",
                jsonPathOperator: "<",
                expectedValue: "1000", // always UP -- this test is about the aggregated VALUE
            });

            const body = {
                resourceMetrics: [
                    {
                        resource: { attributes: [] },
                        scopeMetrics: [
                            {
                                scope: {},
                                metrics: [
                                    {
                                        name: "cpu.usage",
                                        gauge: {
                                            dataPoints: [
                                                { attributes: [], asDouble: 10 },
                                                { attributes: [], asDouble: 20 },
                                                { attributes: [], asDouble: 30 },
                                            ],
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            };

            const res = makeRes();
            await handler(makeReq("last-token", body), res);

            assert.strictEqual(res.statusCode, 200);
            const rows = await heartbeatsFor(monitor.id);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].ping, 30); // last in payload order, not max/avg
        });
    });

    describe("resource-level + datapoint-level attribute merge", () => {
        test("resource attributes merge with datapoint attributes; datapoint-level wins on key collision", async () => {
            const team = await createTeam("merge-token");
            // Selector requires host=payments-1 AND env=prod -- "host" only
            // comes from the datapoint, "env" only from the resource, and a
            // resource-level "region" is deliberately overridden by the
            // datapoint's own "region" attribute.
            const monitor = await createOtelMonitor(team.id, {
                name: "merge-monitor",
                otel_metric_name: "cpu.usage",
                otel_attribute_matchers: JSON.stringify({ host: "payments-1", env: "prod", region: "us-east" }),
                jsonPathOperator: "<",
                expectedValue: "1000",
            });

            const res = makeRes();
            await handler(
                makeReq(
                    "merge-token",
                    buildOtlpBody({
                        metricName: "cpu.usage",
                        value: 55,
                        resourceAttributes: [
                            { key: "env", value: { stringValue: "prod" } },
                            { key: "region", value: { stringValue: "eu-west" } },
                        ],
                        dataPointAttributes: [
                            { key: "host", value: { stringValue: "payments-1" } },
                            { key: "region", value: { stringValue: "us-east" } },
                        ],
                    })
                ),
                res
            );

            assert.strictEqual(res.statusCode, 200);
            const rows = await heartbeatsFor(monitor.id);
            assert.strictEqual(rows.length, 1, "datapoint-level region must win, matching the monitor's selector");
            assert.strictEqual(rows[0].ping, 55);
        });

        test("when the datapoint's attribute does NOT override the resource's conflicting value, the selector must NOT match", async () => {
            const team = await createTeam("merge-no-match-token");
            const monitor = await createOtelMonitor(team.id, {
                name: "merge-no-match-monitor",
                otel_metric_name: "cpu.usage",
                otel_attribute_matchers: JSON.stringify({ region: "us-east" }),
            });

            const res = makeRes();
            await handler(
                makeReq(
                    "merge-no-match-token",
                    buildOtlpBody({
                        metricName: "cpu.usage",
                        value: 55,
                        resourceAttributes: [{ key: "region", value: { stringValue: "eu-west" } }],
                        dataPointAttributes: [{ key: "region", value: { stringValue: "ap-south" } }],
                    })
                ),
                res
            );

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(
                (await heartbeatsFor(monitor.id)).length,
                0,
                "datapoint's region (ap-south) wins over resource's (eu-west) -- neither is us-east, so no match"
            );
        });
    });

    describe("maintenance override", () => {
        test("a monitor under maintenance gets MAINTENANCE status regardless of the evaluated condition", async () => {
            const team = await createTeam("maint-token");
            const monitor = await createOtelMonitor(team.id, {
                name: "maint-monitor",
                otel_metric_name: "cpu.usage",
                jsonPathOperator: "<",
                expectedValue: "90", // 42.5 < 90 would normally be UP
            });
            await putUnderMaintenance(monitor.id);

            const res = makeRes();
            await handler(makeReq("maint-token", buildOtlpBody({ metricName: "cpu.usage", value: 42.5 })), res);

            assert.strictEqual(res.statusCode, 200);
            const rows = await heartbeatsFor(monitor.id);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].status, MAINTENANCE);
        });
    });

    describe("malformed body", () => {
        test("body is not an object -> 400 {ok:false, msg}", async () => {
            const team = await createTeam("malformed-token-1");
            await createOtelMonitor(team.id);

            const res = makeRes();
            await handler(makeReq("malformed-token-1", "this is not json"), res);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.ok, false);
            assert.ok(typeof res.body.msg === "string" && res.body.msg.length > 0);
        });

        test("body missing resourceMetrics[] -> 400", async () => {
            const team = await createTeam("malformed-token-2");
            await createOtelMonitor(team.id);

            const res = makeRes();
            await handler(makeReq("malformed-token-2", { foo: "bar" }), res);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.ok, false);
        });
    });

    describe("unsupported metric type is skipped, not fatal to the batch", () => {
        test("a histogram entry is silently skipped while a sibling gauge metric in the SAME payload still processes correctly", async () => {
            const team = await createTeam("histogram-token");
            const gaugeMonitor = await createOtelMonitor(team.id, {
                name: "histogram-sibling-gauge-monitor",
                otel_metric_name: "cpu.usage",
                jsonPathOperator: "<",
                expectedValue: "90",
            });
            const histogramMonitor = await createOtelMonitor(team.id, {
                name: "histogram-monitor",
                otel_metric_name: "request.duration",
            });

            const body = {
                resourceMetrics: [
                    {
                        resource: { attributes: [] },
                        scopeMetrics: [
                            {
                                scope: {},
                                metrics: [
                                    {
                                        name: "request.duration",
                                        histogram: {
                                            dataPoints: [{ count: "5", sum: 123.4 }],
                                        },
                                    },
                                    {
                                        name: "cpu.usage",
                                        gauge: {
                                            dataPoints: [{ attributes: [], asDouble: 42.5 }],
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            };

            const res = makeRes();
            await handler(makeReq("histogram-token", body), res);

            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, {});

            assert.strictEqual(
                (await heartbeatsFor(histogramMonitor.id)).length,
                0,
                "the histogram metric type is unsupported in v1 and must never produce a heartbeat"
            );
            const gaugeRows = await heartbeatsFor(gaugeMonitor.id);
            assert.strictEqual(
                gaugeRows.length,
                1,
                "the sibling gauge metric in the same payload must still be processed"
            );
            assert.strictEqual(gaugeRows[0].status, UP);
            assert.strictEqual(gaugeRows[0].ping, 42.5);
        });
    });

    describe("successful response shape", () => {
        test("a successful ingest responds with exactly {} and HTTP 200 (empty ExportMetricsServiceResponse)", async () => {
            const team = await createTeam("response-shape-token");
            await createOtelMonitor(team.id, { name: "response-shape-monitor", otel_metric_name: "cpu.usage" });

            const res = makeRes();
            await handler(makeReq("response-shape-token", buildOtlpBody({ metricName: "cpu.usage", value: 1 })), res);

            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, {});
            assert.deepStrictEqual(Object.keys(res.body), []);
        });
    });
});
