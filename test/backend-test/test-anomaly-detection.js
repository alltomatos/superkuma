const { describe, test } = require("node:test");
const assert = require("node:assert");
const {
    computeBaseline,
    computeAnomalyScore,
    isAnomalous,
    detectAnomaly,
} = require("../../server/anomaly-detection");

describe("anomaly-detection.js - computeBaseline()", () => {
    test("computes the correct mean and stddev for a normal sample array", () => {
        // Samples: 10, 20, 30, 40, 50 -> mean 30, population variance 200, stddev sqrt(200).
        const { mean, stddev } = computeBaseline([10, 20, 30, 40, 50]);

        assert.strictEqual(mean, 30);
        assert.ok(Math.abs(stddev - Math.sqrt(200)) < 1e-9, `expected stddev ~${Math.sqrt(200)}, got ${stddev}`);
    });

    test("a single-sample window has mean equal to the sample and stddev exactly 0", () => {
        const { mean, stddev } = computeBaseline([42]);

        assert.strictEqual(mean, 42);
        assert.strictEqual(stddev, 0);
    });

    test("a flat (identical-value) window has stddev exactly 0", () => {
        const { mean, stddev } = computeBaseline([100, 100, 100, 100]);

        assert.strictEqual(mean, 100);
        assert.strictEqual(stddev, 0);
    });

    test("throws a clear Error on an empty array", () => {
        assert.throws(() => computeBaseline([]), /empty/);
    });

    test("throws on a non-array input", () => {
        assert.throws(() => computeBaseline(undefined), /empty/);
        assert.throws(() => computeBaseline(null), /empty/);
    });
});

describe("anomaly-detection.js - computeAnomalyScore()", () => {
    test("computes the correct z-score for typical values", () => {
        const baseline = { mean: 100, stddev: 10 };

        assert.strictEqual(computeAnomalyScore(120, baseline), 2);
        assert.strictEqual(computeAnomalyScore(80, baseline), 2);
        assert.strictEqual(computeAnomalyScore(100, baseline), 0);
        assert.strictEqual(computeAnomalyScore(105, baseline), 0.5);
    });

    test("a perfectly flat baseline (stddev 0) with currentValue === mean scores 0, not NaN", () => {
        const baseline = { mean: 50, stddev: 0 };

        assert.strictEqual(computeAnomalyScore(50, baseline), 0);
    });

    test("a perfectly flat baseline (stddev 0) with currentValue !== mean scores Infinity, not NaN", () => {
        const baseline = { mean: 50, stddev: 0 };

        const score = computeAnomalyScore(51, baseline);
        assert.strictEqual(score, Infinity);
        assert.ok(!Number.isFinite(score), "score must not be finite (and definitely not NaN)");
        assert.ok(!Number.isNaN(score), "score must never be NaN");
    });

    test("even a tiny deviation off a flat baseline is treated as maximally anomalous", () => {
        const baseline = { mean: 50, stddev: 0 };

        assert.strictEqual(computeAnomalyScore(50.0001, baseline), Infinity);
        assert.strictEqual(computeAnomalyScore(-1000, baseline), Infinity);
    });
});

describe("anomaly-detection.js - isAnomalous()", () => {
    test("'above' direction flags only when currentValue > expected AND score exceeds threshold", () => {
        assert.strictEqual(
            isAnomalous({ score: 3, zThreshold: 2, currentValue: 120, expected: 100, direction: "above" }),
            true,
            "value above expected, score above threshold -> anomalous"
        );
    });

    test("'above' direction: value is above expected but score is below threshold -> not anomalous", () => {
        assert.strictEqual(
            isAnomalous({ score: 1, zThreshold: 2, currentValue: 120, expected: 100, direction: "above" }),
            false
        );
    });

    test("'above' direction: score exceeds threshold but value is BELOW expected -> not anomalous (wrong direction)", () => {
        assert.strictEqual(
            isAnomalous({ score: 3, zThreshold: 2, currentValue: 80, expected: 100, direction: "above" }),
            false
        );
    });

    test("'below' direction flags only when currentValue < expected AND score exceeds threshold", () => {
        assert.strictEqual(
            isAnomalous({ score: 3, zThreshold: 2, currentValue: 80, expected: 100, direction: "below" }),
            true,
            "value below expected, score above threshold -> anomalous"
        );
    });

    test("'below' direction: value is below expected but score is below threshold -> not anomalous", () => {
        assert.strictEqual(
            isAnomalous({ score: 1, zThreshold: 2, currentValue: 80, expected: 100, direction: "below" }),
            false
        );
    });

    test("'below' direction: score exceeds threshold but value is ABOVE expected -> not anomalous (wrong direction)", () => {
        assert.strictEqual(
            isAnomalous({ score: 3, zThreshold: 2, currentValue: 120, expected: 100, direction: "below" }),
            false
        );
    });

    test("'both' direction flags either direction, as long as score exceeds threshold", () => {
        assert.strictEqual(
            isAnomalous({ score: 3, zThreshold: 2, currentValue: 120, expected: 100, direction: "both" }),
            true,
            "above expected"
        );
        assert.strictEqual(
            isAnomalous({ score: 3, zThreshold: 2, currentValue: 80, expected: 100, direction: "both" }),
            true,
            "below expected"
        );
    });

    test("'both' direction still respects the threshold -- low score is not anomalous", () => {
        assert.strictEqual(
            isAnomalous({ score: 1, zThreshold: 2, currentValue: 120, expected: 100, direction: "both" }),
            false
        );
    });

    test("score exactly equal to zThreshold does NOT count as anomalous (strictly greater than required)", () => {
        assert.strictEqual(
            isAnomalous({ score: 2, zThreshold: 2, currentValue: 120, expected: 100, direction: "both" }),
            false
        );
    });

    test("throws on an unrecognized direction string", () => {
        assert.throws(
            () => isAnomalous({ score: 3, zThreshold: 2, currentValue: 120, expected: 100, direction: "sideways" }),
            /Unknown anomaly direction/
        );
    });

    test("throws on an invalid direction even when the score would not have triggered anyway (validation runs first)", () => {
        assert.throws(
            () => isAnomalous({ score: 0, zThreshold: 2, currentValue: 100, expected: 100, direction: "sideways" }),
            /Unknown anomaly direction/
        );
    });
});

describe("anomaly-detection.js - detectAnomaly()", () => {
    test("returns null (not a throw) for empty historicalSamples -- 'not enough data yet' is expected, not an error", () => {
        const result = detectAnomaly({
            currentValue: 999,
            historicalSamples: [],
            zThreshold: 2,
            direction: "both",
        });

        assert.strictEqual(result, null);
    });

    test("returns a correctly-shaped result flagging a clear anomaly (one wild sample against a tight cluster)", () => {
        const historicalSamples = [100, 101, 99, 100, 102, 98, 100];

        const result = detectAnomaly({
            currentValue: 5000,
            historicalSamples,
            zThreshold: 3,
            direction: "both",
        });

        assert.ok(result !== null);
        assert.strictEqual(result.isAnomalous, true);
        assert.ok(result.score > 3, `expected a large score, got ${result.score}`);
        assert.ok(Number.isFinite(result.score), "score should be finite for a non-flat baseline");

        const { mean } = computeBaseline(historicalSamples);
        assert.strictEqual(result.expected, mean);
    });

    test("returns isAnomalous: false for a value well within the normal range", () => {
        const historicalSamples = [100, 101, 99, 100, 102, 98, 100];

        const result = detectAnomaly({
            currentValue: 101,
            historicalSamples,
            zThreshold: 3,
            direction: "both",
        });

        assert.ok(result !== null);
        assert.strictEqual(result.isAnomalous, false);
    });

    test("the returned 'expected' field always equals the computed baseline mean", () => {
        const historicalSamples = [10, 20, 30, 40];
        const { mean } = computeBaseline(historicalSamples);

        const result = detectAnomaly({
            currentValue: 25,
            historicalSamples,
            zThreshold: 2,
            direction: "both",
        });

        assert.strictEqual(result.expected, mean);
    });

    test("respects the direction constraint end-to-end: a huge upward spike is NOT flagged under direction 'below'", () => {
        const historicalSamples = [100, 100, 100, 100, 100];

        const result = detectAnomaly({
            currentValue: 10000,
            historicalSamples,
            zThreshold: 2,
            direction: "below",
        });

        assert.ok(result !== null);
        assert.strictEqual(result.isAnomalous, false, "spike is upward, direction only cares about downward deviations");
        assert.strictEqual(result.score, Infinity, "score itself is still computed and still huge -- only the flag is direction-gated");
    });

    test("propagates the isAnomalous() throw for an invalid direction", () => {
        assert.throws(
            () =>
                detectAnomaly({
                    currentValue: 100,
                    historicalSamples: [1, 2, 3],
                    zThreshold: 2,
                    direction: "sideways",
                }),
            /Unknown anomaly direction/
        );
    });
});
