const { describe, test } = require("node:test");
const assert = require("node:assert");
const { extractLokiValue, parseRangeWindowMs } = require("../../server/monitor-types/loki");

describe("loki.js - extractLokiValue()", () => {
    test("extracts a numeric scalar result", () => {
        const value = extractLokiValue({ resultType: "scalar", result: [1700000000, "7"] });
        assert.strictEqual(value, 7);
    });

    test("extracts the value from a single-entry vector result", () => {
        const value = extractLokiValue({
            resultType: "vector",
            result: [{ metric: { job: "app" }, value: [1700000000, "12"] }],
        });
        assert.strictEqual(value, 12);
    });

    test("throws on an empty vector result", () => {
        assert.throws(() => extractLokiValue({ resultType: "vector", result: [] }), /no data/);
    });

    test("extracts the most recent sample from a matrix result", () => {
        const value = extractLokiValue({
            resultType: "matrix",
            result: [
                {
                    metric: { job: "app" },
                    values: [
                        [1700000000, "3"],
                        [1700000060, "9"],
                    ],
                },
            ],
        });
        assert.strictEqual(value, 9);
    });

    test("throws on an empty matrix result", () => {
        assert.throws(() => extractLokiValue({ resultType: "matrix", result: [] }), /no data/);
    });

    test("throws on a streams (raw log line) result -- never evaluates raw log content", () => {
        assert.throws(
            () => extractLokiValue({ resultType: "streams", result: [{ stream: {}, values: [] }] }),
            /streams.*not supported/
        );
    });

    test("throws on an unsupported/unknown resultType", () => {
        assert.throws(() => extractLokiValue({ resultType: "bogus", result: [] }), /Unsupported Loki resultType/);
    });

    test("falls back to the raw string when the value is not numeric", () => {
        const value = extractLokiValue({ resultType: "scalar", result: [1700000000, "not-a-number"] });
        assert.strictEqual(value, "not-a-number");
    });
});

describe("loki.js - parseRangeWindowMs()", () => {
    test("parses a minutes duration", () => {
        assert.strictEqual(parseRangeWindowMs('count_over_time({job="app"} |= "error" [5m])'), 5 * 60000);
    });

    test("parses a seconds duration", () => {
        assert.strictEqual(parseRangeWindowMs('count_over_time({job="app"}[30s])'), 30 * 1000);
    });

    test("parses an hours duration", () => {
        assert.strictEqual(parseRangeWindowMs('count_over_time({job="app"}[2h])'), 2 * 3600000);
    });

    test("falls back to a 5-minute default when the query has no bracketed duration", () => {
        assert.strictEqual(parseRangeWindowMs('{job="app"}'), 5 * 60000);
    });

    test("falls back to a 5-minute default for an empty/undefined query", () => {
        assert.strictEqual(parseRangeWindowMs(""), 5 * 60000);
        assert.strictEqual(parseRangeWindowMs(undefined), 5 * 60000);
    });
});
