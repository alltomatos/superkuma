const { describe, test } = require("node:test");
const assert = require("node:assert");
const {
    attributeMatchersMatch,
    metricMatchesMonitor,
    aggregate,
    matchDatapointsToMonitors,
    DEFAULT_MAX_MATCHED_DATAPOINTS_PER_MONITOR,
} = require("../../server/otel-selector");

describe("otel-selector.js - attributeMatchersMatch()", () => {
    test("null matchers is a wildcard -- matches any attributes", () => {
        assert.strictEqual(attributeMatchersMatch(null, { service: "payments" }), true);
        assert.strictEqual(attributeMatchersMatch(null, {}), true);
        assert.strictEqual(attributeMatchersMatch(null, null), true);
    });

    test("undefined matchers is a wildcard -- matches any attributes", () => {
        assert.strictEqual(attributeMatchersMatch(undefined, { service: "payments" }), true);
    });

    test("an empty object matchers is a wildcard -- matches any attributes", () => {
        assert.strictEqual(attributeMatchersMatch({}, { service: "payments" }), true);
        assert.strictEqual(attributeMatchersMatch({}, {}), true);
        assert.strictEqual(attributeMatchersMatch({}, null), true);
    });

    test("a single matcher key matches when the attribute value is identical", () => {
        assert.strictEqual(attributeMatchersMatch({ service: "payments" }, { service: "payments" }), true);
    });

    test("a single matcher key does NOT match a different attribute value", () => {
        assert.strictEqual(attributeMatchersMatch({ service: "payments" }, { service: "checkout" }), false);
    });

    test("a single matcher key does NOT match when the attribute is missing entirely", () => {
        assert.strictEqual(attributeMatchersMatch({ service: "payments" }, { region: "us-east" }), false);
    });

    test("matchers with any keys at all do NOT match null/undefined attributes", () => {
        assert.strictEqual(attributeMatchersMatch({ service: "payments" }, null), false);
        assert.strictEqual(attributeMatchersMatch({ service: "payments" }, undefined), false);
    });

    test("multiple matcher keys are a conjunction -- ALL must match, not just one", () => {
        const matchers = { service: "payments", region: "us-east" };

        assert.strictEqual(attributeMatchersMatch(matchers, { service: "payments", region: "us-east" }), true);
        assert.strictEqual(
            attributeMatchersMatch(matchers, { service: "payments", region: "eu-west" }),
            false,
            "service matches but region doesn't -- overall no match"
        );
        assert.strictEqual(
            attributeMatchersMatch(matchers, { service: "checkout", region: "us-east" }),
            false,
            "region matches but service doesn't -- overall no match"
        );
    });

    test("extra attributes beyond the matcher keys are ignored -- matchers is a subset constraint", () => {
        assert.strictEqual(
            attributeMatchersMatch({ service: "payments" }, { service: "payments", region: "us-east", pod: "abc123" }),
            true
        );
    });

    test("matching is exact, not a substring/prefix -- values must be identical", () => {
        assert.strictEqual(attributeMatchersMatch({ service: "pay" }, { service: "payments" }), false);
    });

    test("matching is type-sensitive -- string vs number are not coerced", () => {
        assert.strictEqual(attributeMatchersMatch({ code: "200" }, { code: 200 }), false);
    });
});

describe("otel-selector.js - metricMatchesMonitor()", () => {
    /**
     * Build a fully-permissive otel monitor (no attribute matchers), then
     * apply overrides.
     * @param {object} overrides Fields to override on the base monitor.
     * @returns {object} A monitor-shaped object.
     */
    function makeMonitor(overrides = {}) {
        return {
            id: 1,
            otel_metric_name: "http.server.request.duration",
            otel_attribute_matchers: null,
            ...overrides,
        };
    }

    test("exact metric name match with no matchers configured -> matches any attributes", () => {
        const monitor = makeMonitor();
        const datapoint = { metricName: "http.server.request.duration", attributes: { service: "payments" } };

        assert.strictEqual(metricMatchesMonitor(monitor, datapoint), true);
    });

    test("a different metric name -> never matches, regardless of attributes", () => {
        const monitor = makeMonitor();
        const datapoint = { metricName: "http.server.active_requests", attributes: {} };

        assert.strictEqual(metricMatchesMonitor(monitor, datapoint), false);
    });

    test("otel_attribute_matchers as an empty string is handled gracefully as 'no matchers'", () => {
        const monitor = makeMonitor({ otel_attribute_matchers: "" });
        const datapoint = { metricName: "http.server.request.duration", attributes: { anything: "goes" } };

        assert.strictEqual(metricMatchesMonitor(monitor, datapoint), true);
    });

    test("otel_attribute_matchers as undefined is handled gracefully as 'no matchers'", () => {
        const monitor = makeMonitor({ otel_attribute_matchers: undefined });
        const datapoint = { metricName: "http.server.request.duration", attributes: {} };

        assert.strictEqual(metricMatchesMonitor(monitor, datapoint), true);
    });

    test("otel_attribute_matchers as a JSON string is parsed and enforced", () => {
        const monitor = makeMonitor({ otel_attribute_matchers: '{"service":"payments"}' });

        assert.strictEqual(
            metricMatchesMonitor(monitor, {
                metricName: "http.server.request.duration",
                attributes: { service: "payments", region: "us-east" },
            }),
            true
        );
        assert.strictEqual(
            metricMatchesMonitor(monitor, {
                metricName: "http.server.request.duration",
                attributes: { service: "checkout" },
            }),
            false
        );
    });

    test("metric name matches but a required attribute is missing -> no match (partial-attribute mismatch)", () => {
        const monitor = makeMonitor({ otel_attribute_matchers: '{"service":"payments","region":"us-east"}' });
        const datapoint = {
            metricName: "http.server.request.duration",
            attributes: { service: "payments" }, // region missing
        };

        assert.strictEqual(metricMatchesMonitor(monitor, datapoint), false);
    });

    test("multiple monitors can independently match the same datapoint", () => {
        const wideMonitor = makeMonitor({ id: 1, otel_attribute_matchers: null });
        const narrowMonitor = makeMonitor({ id: 2, otel_attribute_matchers: '{"service":"payments"}' });
        const datapoint = { metricName: "http.server.request.duration", attributes: { service: "payments" } };

        assert.strictEqual(metricMatchesMonitor(wideMonitor, datapoint), true);
        assert.strictEqual(metricMatchesMonitor(narrowMonitor, datapoint), true);
    });
});

describe("otel-selector.js - aggregate()", () => {
    test("'last' returns the last value in payload order", () => {
        assert.strictEqual(aggregate([10, 20, 30], "last"), 30);
        assert.strictEqual(aggregate([5], "last"), 5);
    });

    test("'last' is payload order, not sorted order -- an out-of-order array still returns the last element", () => {
        assert.strictEqual(aggregate([100, 1, 50], "last"), 50);
    });

    test("'avg' returns the arithmetic mean", () => {
        assert.strictEqual(aggregate([10, 20, 30], "avg"), 20);
        assert.strictEqual(aggregate([5], "avg"), 5);
    });

    test("'max' returns the largest value", () => {
        assert.strictEqual(aggregate([10, 30, 20], "max"), 30);
        assert.strictEqual(aggregate([-5, -1, -10], "max"), -1);
    });

    test("'sum' returns the arithmetic sum", () => {
        assert.strictEqual(aggregate([10, 20, 30], "sum"), 60);
        assert.strictEqual(aggregate([5], "sum"), 5);
    });

    test("throws a clear Error on an empty values array", () => {
        assert.throws(() => aggregate([], "sum"), /empty/);
        assert.throws(() => aggregate([], "last"), /empty/);
    });

    test("throws on a non-array input", () => {
        assert.throws(() => aggregate(undefined, "sum"), /empty/);
        assert.throws(() => aggregate(null, "sum"), /empty/);
    });

    test("throws a descriptive Error on an unrecognized aggregation", () => {
        assert.throws(() => aggregate([1, 2, 3], "median"), /Unknown aggregation: median/);
    });

    test("throws on an invalid aggregation even for a single-value array", () => {
        assert.throws(() => aggregate([42], "p99"), /Unknown aggregation: p99/);
    });
});

describe("otel-selector.js - matchDatapointsToMonitors()", () => {
    test("one monitor, one matching datapoint -> a single result entry with matchedCount 1", () => {
        const monitors = [
            { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "last" },
        ];
        const datapoints = [{ metricName: "cpu.usage", attributes: {}, value: 42 }];

        const result = matchDatapointsToMonitors(monitors, datapoints);

        assert.deepStrictEqual(result, [{ monitorId: 1, aggregatedValue: 42, matchedCount: 1 }]);
    });

    test("a monitor matching multiple datapoints aggregates them per its configured aggregation ('avg')", () => {
        const monitors = [
            { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "avg" },
        ];
        const datapoints = [
            { metricName: "cpu.usage", attributes: {}, value: 10 },
            { metricName: "cpu.usage", attributes: {}, value: 20 },
            { metricName: "cpu.usage", attributes: {}, value: 30 },
        ];

        const result = matchDatapointsToMonitors(monitors, datapoints);

        assert.deepStrictEqual(result, [{ monitorId: 1, aggregatedValue: 20, matchedCount: 3 }]);
    });

    test("a monitor matching multiple datapoints aggregates per 'max'", () => {
        const monitors = [
            { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "max" },
        ];
        const datapoints = [
            { metricName: "cpu.usage", attributes: {}, value: 10 },
            { metricName: "cpu.usage", attributes: {}, value: 99 },
            { metricName: "cpu.usage", attributes: {}, value: 30 },
        ];

        const result = matchDatapointsToMonitors(monitors, datapoints);

        assert.deepStrictEqual(result, [{ monitorId: 1, aggregatedValue: 99, matchedCount: 3 }]);
    });

    test("a monitor matching multiple datapoints aggregates per 'sum'", () => {
        const monitors = [
            { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "sum" },
        ];
        const datapoints = [
            { metricName: "cpu.usage", attributes: {}, value: 10 },
            { metricName: "cpu.usage", attributes: {}, value: 20 },
        ];

        const result = matchDatapointsToMonitors(monitors, datapoints);

        assert.deepStrictEqual(result, [{ monitorId: 1, aggregatedValue: 30, matchedCount: 2 }]);
    });

    test("a monitor matching multiple datapoints aggregates per 'last' (last in payload order)", () => {
        const monitors = [
            { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "last" },
        ];
        const datapoints = [
            { metricName: "cpu.usage", attributes: {}, value: 10 },
            { metricName: "cpu.usage", attributes: {}, value: 999 },
            { metricName: "cpu.usage", attributes: {}, value: 30 },
        ];

        const result = matchDatapointsToMonitors(monitors, datapoints);

        assert.deepStrictEqual(result, [{ monitorId: 1, aggregatedValue: 30, matchedCount: 3 }]);
    });

    test("multiple monitors matching the same datapoint -> both get an entry, each with matchedCount 1", () => {
        const monitors = [
            { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "last" },
            {
                id: 2,
                otel_metric_name: "cpu.usage",
                otel_attribute_matchers: '{"host":"web-1"}',
                otel_aggregation: "last",
            },
        ];
        const datapoints = [{ metricName: "cpu.usage", attributes: { host: "web-1" }, value: 77 }];

        const result = matchDatapointsToMonitors(monitors, datapoints);

        assert.strictEqual(result.length, 2);
        assert.deepStrictEqual(result, [
            { monitorId: 1, aggregatedValue: 77, matchedCount: 1 },
            { monitorId: 2, aggregatedValue: 77, matchedCount: 1 },
        ]);
    });

    test("a datapoint matching zero monitors is dropped -- it contributes to no result entry", () => {
        const monitors = [
            { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "last" },
        ];
        const datapoints = [{ metricName: "memory.usage", attributes: {}, value: 55 }];

        const result = matchDatapointsToMonitors(monitors, datapoints);

        assert.deepStrictEqual(result, []);
    });

    test("a monitor matching zero datapoints is absent from the result -- not included with a null value", () => {
        const monitors = [
            { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "last" },
            { id: 2, otel_metric_name: "memory.usage", otel_attribute_matchers: null, otel_aggregation: "last" },
        ];
        const datapoints = [{ metricName: "cpu.usage", attributes: {}, value: 42 }];

        const result = matchDatapointsToMonitors(monitors, datapoints);

        assert.strictEqual(result.length, 1);
        assert.deepStrictEqual(result, [{ monitorId: 1, aggregatedValue: 42, matchedCount: 1 }]);
    });

    test("empty monitors list -> empty result, regardless of datapoints", () => {
        const datapoints = [{ metricName: "cpu.usage", attributes: {}, value: 42 }];

        assert.deepStrictEqual(matchDatapointsToMonitors([], datapoints), []);
    });

    test("empty datapoints list -> empty result, regardless of monitors", () => {
        const monitors = [
            { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "last" },
        ];

        assert.deepStrictEqual(matchDatapointsToMonitors(monitors, []), []);
    });

    test("a batch with multiple distinct metrics only routes each datapoint to the monitor(s) whose selector matches", () => {
        const monitors = [
            { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "avg" },
            { id: 2, otel_metric_name: "memory.usage", otel_attribute_matchers: null, otel_aggregation: "max" },
        ];
        const datapoints = [
            { metricName: "cpu.usage", attributes: {}, value: 10 },
            { metricName: "memory.usage", attributes: {}, value: 500 },
            { metricName: "cpu.usage", attributes: {}, value: 20 },
            { metricName: "disk.io", attributes: {}, value: 1000 }, // matches nothing, dropped
            { metricName: "memory.usage", attributes: {}, value: 700 },
        ];

        const result = matchDatapointsToMonitors(monitors, datapoints);

        assert.deepStrictEqual(result, [
            { monitorId: 1, aggregatedValue: 15, matchedCount: 2 },
            { monitorId: 2, aggregatedValue: 700, matchedCount: 2 },
        ]);
    });

    test("propagates aggregate()'s throw for an invalid otel_aggregation, but only for a monitor that actually matched", () => {
        const monitors = [
            { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "median" },
        ];
        const datapoints = [{ metricName: "cpu.usage", attributes: {}, value: 42 }];

        assert.throws(() => matchDatapointsToMonitors(monitors, datapoints), /Unknown aggregation: median/);
    });

    test("an invalid otel_aggregation on a monitor with zero matches does NOT throw -- aggregate() is never called", () => {
        const monitors = [
            { id: 1, otel_metric_name: "memory.usage", otel_attribute_matchers: null, otel_aggregation: "median" },
        ];
        const datapoints = [{ metricName: "cpu.usage", attributes: {}, value: 42 }];

        assert.doesNotThrow(() => matchDatapointsToMonitors(monitors, datapoints));
        assert.deepStrictEqual(matchDatapointsToMonitors(monitors, datapoints), []);
    });

    describe("cardinality cap (ADR-0015 TASK-A2-4 hardening)", () => {
        test("exports a default cap of 1000", () => {
            assert.strictEqual(DEFAULT_MAX_MATCHED_DATAPOINTS_PER_MONITOR, 1000);
        });

        test("a batch under the cap is untouched -- result shape is byte-for-byte identical to before this guard existed", () => {
            const monitors = [
                { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "avg" },
            ];
            const datapoints = [
                { metricName: "cpu.usage", attributes: {}, value: 10 },
                { metricName: "cpu.usage", attributes: {}, value: 20 },
            ];

            // Explicit small cap, well above this batch's size -- still no
            // truncation, so the extra keys must NOT appear.
            const result = matchDatapointsToMonitors(monitors, datapoints, 10);

            assert.deepStrictEqual(result, [{ monitorId: 1, aggregatedValue: 15, matchedCount: 2 }]);
        });

        test("a batch exactly AT the cap is not truncated", () => {
            const monitors = [
                { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "sum" },
            ];
            const datapoints = Array.from({ length: 10 }, () => ({
                metricName: "cpu.usage",
                attributes: {},
                value: 1,
            }));

            const result = matchDatapointsToMonitors(monitors, datapoints, 10);

            assert.deepStrictEqual(result, [{ monitorId: 1, aggregatedValue: 10, matchedCount: 10 }]);
        });

        test("a batch OVER a small explicit cap is truncated to the first N (payload order), and reports totalMatchedCount", () => {
            const monitors = [
                { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "avg" },
            ];
            // 15 matching datapoints, values 1..15, cap of 10 -- aggregation
            // must run over the FIRST 10 (1..10), not all 15.
            const datapoints = Array.from({ length: 15 }, (_, i) => ({
                metricName: "cpu.usage",
                attributes: {},
                value: i + 1,
            }));

            const result = matchDatapointsToMonitors(monitors, datapoints, 10);

            assert.deepStrictEqual(result, [
                {
                    monitorId: 1,
                    aggregatedValue: 5.5, // avg(1..10)
                    matchedCount: 10,
                    truncated: true,
                    totalMatchedCount: 15,
                },
            ]);
        });

        test("truncation is per-monitor -- a monitor under its own cap is unaffected by a sibling monitor's truncation", () => {
            const monitors = [
                { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "avg" },
                {
                    id: 2,
                    otel_metric_name: "cpu.usage",
                    otel_attribute_matchers: '{"host":"web-1"}',
                    otel_aggregation: "last",
                },
            ];
            // Monitor 1 (wildcard) matches all 12 datapoints -- over the cap
            // of 10. Monitor 2 only matches the ONE "web-1" datapoint -- well
            // under the cap, must NOT be marked truncated.
            const datapoints = Array.from({ length: 12 }, (_, i) => ({
                metricName: "cpu.usage",
                attributes: i === 0 ? { host: "web-1" } : {},
                value: i + 1,
            }));

            const result = matchDatapointsToMonitors(monitors, datapoints, 10);

            assert.strictEqual(result.length, 2);
            assert.deepStrictEqual(result[0], {
                monitorId: 1,
                aggregatedValue: 5.5, // avg(1..10) -- truncated
                matchedCount: 10,
                truncated: true,
                totalMatchedCount: 12,
            });
            assert.deepStrictEqual(result[1], {
                monitorId: 2,
                aggregatedValue: 1, // the single "web-1" datapoint's value
                matchedCount: 1,
            });
        });

        test("aggregate() still throws for an invalid otel_aggregation even when the batch is truncated", () => {
            const monitors = [
                { id: 1, otel_metric_name: "cpu.usage", otel_attribute_matchers: null, otel_aggregation: "median" },
            ];
            const datapoints = Array.from({ length: 15 }, (_, i) => ({
                metricName: "cpu.usage",
                attributes: {},
                value: i + 1,
            }));

            assert.throws(() => matchDatapointsToMonitors(monitors, datapoints, 10), /Unknown aggregation: median/);
        });
    });
});
