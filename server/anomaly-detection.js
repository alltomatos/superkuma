/**
 * Pure response-time anomaly detector (ADR-0013, TASK-A1-2), Phase 1: moving
 * average +/- N standard deviations, NO seasonality (seasonality is Phase 2,
 * explicitly future work per the ADR). No I/O -- callers (TASK-A1-3) fetch
 * the historical samples from UptimeCalculator.getDataArray() and pass them
 * in as plain numbers, then persist/notify based on the result. Kept
 * separate from server/model/monitor.js on purpose so the statistics are
 * unit-testable without a database, mirroring server/notification-routing.js.
 *
 * CRITICAL CONTRACT: every "historicalSamples" parameter in this file is
 * assumed to ALREADY EXCLUDE the current/in-progress sample under
 * evaluation. Per test/backend-test/test-uptime-calculator-anomaly-window.js
 * (TASK-A1-0), UptimeCalculator.getDataArray(N, "minute") called right after
 * the current sample's own update() returns the CURRENT in-progress bucket
 * as index 0 -- the caller must fetch N+1 buckets and drop index 0 before
 * building a "historical" window here. This module does not and cannot
 * enforce that (it has no idea where the numbers came from) -- it only
 * documents the requirement loudly so a future reader of TASK-A1-3's wiring
 * code does not accidentally compare the current value against a window
 * that already contains itself (which would silently deflate every score).
 */

/**
 * Compute the mean and (population) standard deviation of a set of
 * historical samples. This is the strict internal building block: unlike
 * detectAnomaly() below, it refuses to guess when there is nothing to
 * compute from, rather than returning a garbage baseline like
 * `{ mean: NaN, stddev: NaN }` that would silently poison every downstream
 * score.
 * @param {number[]} historicalSamples Plain numeric samples (e.g. avgPing
 *     values already extracted from UptimeCalculator buckets by the caller).
 *     MUST already exclude the current/in-progress sample -- see the
 *     module-level contract note above.
 * @returns {{mean: number, stddev: number}} The sample mean and population
 *     standard deviation (divide-by-N, not divide-by-N-1) of historicalSamples.
 *     Population stddev is used deliberately so a single-sample window
 *     produces a well-defined `stddev: 0` instead of a 0/0 NaN.
 * @throws {Error} If historicalSamples is empty (or not an array) -- there is
 *     no baseline to compute. Callers with insufficient history (e.g. a
 *     monitor's first few beats) are expected to skip evaluation entirely
 *     rather than call this function; see detectAnomaly(), which does that
 *     check for you and returns null instead of throwing.
 */
function computeBaseline(historicalSamples) {
    if (!Array.isArray(historicalSamples) || historicalSamples.length === 0) {
        throw new Error("Cannot compute a baseline from an empty historicalSamples array");
    }

    const n = historicalSamples.length;
    const mean = historicalSamples.reduce((sum, value) => sum + value, 0) / n;
    const variance = historicalSamples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
    const stddev = Math.sqrt(variance);

    return { mean, stddev };
}

/**
 * Compute the anomaly z-score of a value against a baseline: how many
 * standard deviations away from the mean the current value sits.
 * @param {number} currentValue The value under evaluation (e.g. this beat's response time).
 * @param {{mean: number, stddev: number}} baseline A baseline as returned by computeBaseline().
 * @returns {number} The z-score `|currentValue - mean| / stddev`. Deliberately
 *     handled for the `stddev === 0` edge case (a perfectly flat history) instead
 *     of letting the division silently produce NaN: if currentValue also equals
 *     mean, the score is 0 (no anomaly -- the value matches the flat baseline
 *     exactly). If currentValue differs from mean at all despite zero variance,
 *     the score is `Infinity` (any deviation off a perfectly flat baseline is
 *     maximally anomalous, since there is no observed variance to normalize by).
 */
function computeAnomalyScore(currentValue, baseline) {
    const { mean, stddev } = baseline;

    if (stddev === 0) {
        return currentValue === mean ? 0 : Infinity;
    }

    return Math.abs(currentValue - mean) / stddev;
}

/**
 * Decide whether a computed score, combined with a directional constraint,
 * counts as an anomaly. The direction check and the score-vs-threshold check
 * are both required: a value can be on the "right" side of expected yet have
 * too low a score (not anomalous), or have a high score yet be moving the
 * "wrong" direction for what the monitor cares about (also not anomalous).
 * @param {object} params Evaluation inputs.
 * @param {number} params.score The z-score, as returned by computeAnomalyScore().
 * @param {number} params.zThreshold The configured minimum score to count as anomalous
 *     (the alert fires when score is STRICTLY GREATER than this, per the ADR's
 *     "dispara se score > z_threshold").
 * @param {number} params.currentValue The value under evaluation.
 * @param {number} params.expected The baseline's expected value (baseline.mean in Phase 1).
 * @param {string} params.direction Which deviations count: "above" (only
 *     currentValue > expected), "below" (only currentValue < expected), or
 *     "both" (either direction), matching the monitor.anomaly_direction column.
 * @returns {boolean} True if this evaluation should be flagged as anomalous.
 * @throws {Error} If direction is not one of "above", "below", "both". This check
 *     runs BEFORE the score/direction logic below, so an invalid direction always
 *     throws regardless of score -- fail loud, matching severityMeetsThreshold()'s
 *     style in server/notification-routing.js.
 */
function isAnomalous({ score, zThreshold, currentValue, expected, direction }) {
    if (direction !== "above" && direction !== "below" && direction !== "both") {
        throw new Error(`Unknown anomaly direction: ${direction}`);
    }

    if (score <= zThreshold) {
        return false;
    }

    if (direction === "above") {
        return currentValue > expected;
    }

    if (direction === "below") {
        return currentValue < expected;
    }

    // direction === "both": either side of expected counts.
    return currentValue !== expected;
}

/**
 * The single entry point TASK-A1-3's beat()-adjacent wiring will actually
 * call. Composes computeBaseline(), computeAnomalyScore() and isAnomalous()
 * into one evaluation. Unlike computeBaseline(), this is the FORGIVING public
 * entry point: an empty historicalSamples array is a normal, expected state
 * (e.g. a monitor's first few beats, or a monitor that just had
 * anomaly_enabled flipped on) -- not an error condition -- so it returns null
 * rather than throwing.
 * @param {object} params Evaluation inputs.
 * @param {number} params.currentValue The value under evaluation (e.g. this beat's response time).
 * @param {number[]} params.historicalSamples Plain numeric samples to build the baseline
 *     from. MUST already exclude the current/in-progress sample -- see the
 *     module-level contract note at the top of this file. An empty array means
 *     "not enough history yet" and short-circuits to a null return.
 * @param {number} params.zThreshold The configured minimum score to count as anomalous.
 * @param {string} params.direction Which deviations count: "above", "below", or "both".
 * @returns {?{isAnomalous: boolean, score: number, expected: number}} null when
 *     historicalSamples is empty ("not enough data yet" -- not an error). Otherwise
 *     an object with the anomaly verdict, the computed z-score, and the baseline's
 *     expected value (the mean of historicalSamples) for the caller to persist/report.
 * @throws {Error} If direction is not one of "above", "below", "both" (propagated
 *     from isAnomalous()).
 */
function detectAnomaly({ currentValue, historicalSamples, zThreshold, direction }) {
    if (!historicalSamples || historicalSamples.length === 0) {
        return null;
    }

    const baseline = computeBaseline(historicalSamples);
    const score = computeAnomalyScore(currentValue, baseline);
    const anomalous = isAnomalous({
        score,
        zThreshold,
        currentValue,
        expected: baseline.mean,
        direction,
    });

    return {
        isAnomalous: anomalous,
        score,
        expected: baseline.mean,
    };
}

module.exports = {
    computeBaseline,
    computeAnomalyScore,
    isAnomalous,
    detectAnomaly,
};
