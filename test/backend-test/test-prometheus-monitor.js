const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const { PrometheusMonitorType } = require("../../server/monitor-types/prometheus");
const { UP } = require("../../src/util");

describe("Prometheus monitor type", () => {
    describe("extractValue", () => {
        const p = new PrometheusMonitorType();

        test("scalar result → number", () => {
            assert.strictEqual(p.extractValue({ resultType: "scalar", result: [1700000000, "42.5"] }), 42.5);
        });

        test("vector result → first series value", () => {
            assert.strictEqual(
                p.extractValue({ resultType: "vector", result: [{ metric: {}, value: [1700000000, "93.2"] }] }),
                93.2
            );
        });

        test("empty vector throws", () => {
            assert.throws(() => p.extractValue({ resultType: "vector", result: [] }), /no data/);
        });

        test("matrix (range) result is rejected", () => {
            assert.throws(() => p.extractValue({ resultType: "matrix", result: [] }), /not supported/);
        });

        test("non-numeric string is kept as a string", () => {
            assert.strictEqual(p.extractValue({ resultType: "string", result: [1700000000, "ok"] }), "ok");
        });
    });

    describe("check() against a mock Prometheus", () => {
        let server;
        let base;

        before(async () => {
            server = http.createServer((req, res) => {
                const query = new URL(req.url, "http://x").searchParams.get("query");
                res.setHeader("content-type", "application/json");
                if (query === "error") {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ status: "error", errorType: "bad_data", error: "parse error" }));
                } else if (query === "empty") {
                    res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }));
                } else {
                    res.end(
                        JSON.stringify({
                            status: "success",
                            data: {
                                resultType: "vector",
                                result: [{ metric: { instance: "srv1" }, value: [1700000000, "93.2"] }],
                            },
                        })
                    );
                }
            });
            await new Promise((resolve) => server.listen(0, resolve));
            base = "http://127.0.0.1:" + server.address().port;
        });

        after(() => server.close());

        /**
         * Build a monitor stub for the check() call.
         * @param {object} over Fields to override.
         * @returns {object} The monitor stub.
         */
        const mk = (over = {}) => ({
            url: base,
            databaseQuery: "cpu",
            jsonPath: "$",
            jsonPathOperator: "<",
            expectedValue: "95",
            timeout: 5,
            interval: 60,
            ...over,
        });

        test("UP when the condition passes (93.2 < 95)", async () => {
            const heartbeat = {};
            await new PrometheusMonitorType().check(mk(), heartbeat, null);
            assert.strictEqual(heartbeat.status, UP);
            assert.strictEqual(typeof heartbeat.ping, "number");
        });

        test("DOWN (throws) when the condition fails (93.2 < 90)", async () => {
            await assert.rejects(
                () => new PrometheusMonitorType().check(mk({ expectedValue: "90" }), {}, null),
                /does not pass/
            );
        });

        test("throws on a Prometheus error status", async () => {
            await assert.rejects(
                () => new PrometheusMonitorType().check(mk({ databaseQuery: "error" }), {}, null),
                /Prometheus query failed/
            );
        });

        test("throws on an empty result", async () => {
            await assert.rejects(
                () => new PrometheusMonitorType().check(mk({ databaseQuery: "empty" }), {}, null),
                /no data/
            );
        });

        test("requires a URL", async () => {
            await assert.rejects(() => new PrometheusMonitorType().check(mk({ url: "" }), {}, null), /URL is required/);
        });

        test("requires a PromQL query", async () => {
            await assert.rejects(
                () => new PrometheusMonitorType().check(mk({ databaseQuery: "" }), {}, null),
                /query is required/
            );
        });
    });
});
