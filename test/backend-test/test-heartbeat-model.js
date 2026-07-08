process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test } = require("node:test");
const assert = require("node:assert");
const Heartbeat = require("../../server/model/heartbeat");

describe("Heartbeat model", () => {
    describe("extractPublicMetricValue()", () => {
        test("parses the value out of a passing PromQL message", () => {
            const value = Heartbeat.extractPublicMetricValue("PromQL condition passes (72.3 < 90)");
            assert.strictEqual(value, 72.3);
        });

        test("parses the value out of a failing PromQL message", () => {
            const value = Heartbeat.extractPublicMetricValue("PromQL condition does not pass (95 > 90)");
            assert.strictEqual(value, 95);
        });

        test("parses negative and scientific-notation values", () => {
            assert.strictEqual(Heartbeat.extractPublicMetricValue("PromQL condition passes (-3.5 < 0)"), -3.5);
            assert.strictEqual(Heartbeat.extractPublicMetricValue("PromQL condition passes (1e3 > 90)"), 1000);
        });

        test("parses the value out of a passing JSON query message (snmp/json-query)", () => {
            const value = Heartbeat.extractPublicMetricValue("JSON query passes (comparing 42 > 10)");
            assert.strictEqual(value, 42);
        });

        test("parses the value out of a failing JSON query message", () => {
            const value = Heartbeat.extractPublicMetricValue("JSON query does not pass (comparing 12.5 <= 10)");
            assert.strictEqual(value, 12.5);
        });

        test("returns null for a non-numeric JSON query comparison (string, not a metric)", () => {
            assert.strictEqual(Heartbeat.extractPublicMetricValue("JSON query passes (comparing OK == OK)"), null);
        });

        test("returns null for messages from other monitor types (no leak of arbitrary text)", () => {
            assert.strictEqual(Heartbeat.extractPublicMetricValue("Connection refused (ECONNREFUSED)"), null);
            assert.strictEqual(Heartbeat.extractPublicMetricValue("200 - OK"), null);
        });

        test("returns null for empty/undefined messages", () => {
            assert.strictEqual(Heartbeat.extractPublicMetricValue(""), null);
            assert.strictEqual(Heartbeat.extractPublicMetricValue(undefined), null);
            assert.strictEqual(Heartbeat.extractPublicMetricValue(null), null);
        });
    });

    describe("toPublicJSON()", () => {
        /**
         * Build a bare Heartbeat instance with the given fields, bypassing the
         * database (mirrors the "small pure/near-pure helpers" pattern in
         * test-monitor-model.js).
         * @param {object} fields Heartbeat fields to assign
         * @returns {Heartbeat} A detached Heartbeat instance
         */
        function makeHeartbeat(fields) {
            const hb = Object.create(Heartbeat.prototype);
            Object.assign(hb, fields);
            return hb;
        }

        test("hides msg and omits metricValue for a non-prometheus monitor", () => {
            const hb = makeHeartbeat({ status: 1, time: "2026-01-01 00:00:00", ping: 42, msg: "200 - OK" });

            const json = hb.toPublicJSON("http");

            assert.deepStrictEqual(Object.keys(json).sort(), ["msg", "ping", "status", "time"]);
            assert.strictEqual(json.msg, "");
            assert.strictEqual(json.ping, 42);
        });

        test("adds metricValue for a prometheus monitor with a recognized message", () => {
            const hb = makeHeartbeat({
                status: 1,
                time: "2026-01-01 00:00:00",
                ping: 10,
                msg: "PromQL condition passes (72.3 < 90)",
            });

            const json = hb.toPublicJSON("prometheus");

            assert.deepStrictEqual(Object.keys(json).sort(), ["metricValue", "msg", "ping", "status", "time"]);
            assert.strictEqual(json.metricValue, 72.3);
            assert.strictEqual(json.msg, "", "msg itself must still be hidden even though a value was extracted");
        });

        test("omits metricValue for a prometheus monitor whose message doesn't match (fails safe, no crash)", () => {
            const hb = makeHeartbeat({ status: 0, time: "2026-01-01 00:00:00", ping: null, msg: "some other error" });

            const json = hb.toPublicJSON("prometheus");

            assert.deepStrictEqual(Object.keys(json).sort(), ["msg", "ping", "status", "time"]);
        });

        test("adds metricValue for snmp and json-query monitors (comparing-style message)", () => {
            for (const type of ["snmp", "json-query"]) {
                const hb = makeHeartbeat({
                    status: 1,
                    time: "2026-01-01 00:00:00",
                    ping: 10,
                    msg: "JSON query passes (comparing 12.5 < 80)",
                });

                const json = hb.toPublicJSON(type);

                assert.deepStrictEqual(
                    Object.keys(json).sort(),
                    ["metricValue", "msg", "ping", "status", "time"],
                    `metricValue expected for ${type}`
                );
                assert.strictEqual(json.metricValue, 12.5);
                assert.strictEqual(json.msg, "");
            }
        });

        test("omits metricValue for a string-comparison json-query (not a numeric metric)", () => {
            const hb = makeHeartbeat({
                status: 1,
                time: "2026-01-01 00:00:00",
                ping: 10,
                msg: "JSON query passes (comparing OK == OK)",
            });

            const json = hb.toPublicJSON("json-query");

            assert.deepStrictEqual(Object.keys(json).sort(), ["msg", "ping", "status", "time"]);
        });
    });
});
