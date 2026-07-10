/**
 * Pure OTLP metric-to-monitor matching and aggregation logic (ADR-0015,
 * TASK-A2-2/A2-3, decision 3 "Selector-first, drop-by-default"). No I/O --
 * callers (the future server/routers/telemetry-router.js) parse the raw
 * OTLP/JSON payload, flatten/merge resource-level + datapoint-level
 * attributes into plain objects, and pass the result in here as plain data.
 * Kept separate from server/model/monitor.js on purpose so the matching and
 * aggregation rules are unit-testable without a database, mirroring
 * server/notification-routing.js and server/anomaly-detection.js.
 *
 * The cardinality guard from the ADR is enforced entirely by shape here: a
 * monitor with zero matching datapoints is simply absent from
 * matchDatapointsToMonitors()'s result (dropped, never persisted with a null
 * placeholder), and a datapoint matching no monitor's selector never
 * contributes to any monitor's matched set -- it is implicitly discarded by
 * never being read.
 */

/**
 * Whether every key in a monitor's attribute matchers has an EXACT matching
 * value in an incoming datapoint's attributes. Conjunctive AND across all
 * keys -- same idiom as routeMatches() in server/notification-routing.js,
 * where every non-null selector field must hold at once. An empty, null, or
 * undefined matchers object is a wildcard that matches any attributes at
 * all (including empty attributes), mirroring how a null selector field is
 * a wildcard in routeMatches().
 * @param {?{[key: string]: string}} matchers Plain object of attribute
 *     key:value pairs the monitor requires, already JSON-parsed by the
 *     caller (or by metricMatchesMonitor() below). Null/undefined/empty
 *     means "match any attributes".
 * @param {?{[key: string]: string}} attributes Plain object of the incoming
 *     datapoint's merged attributes (resource-level + datapoint-level,
 *     already merged by the caller).
 * @returns {boolean} True if every matcher key has an identical value in
 *     attributes (or matchers has no keys at all).
 */
function attributeMatchersMatch(matchers, attributes) {
    if (!matchers) {
        return true;
    }

    const requiredKeys = Object.keys(matchers);
    if (requiredKeys.length === 0) {
        return true;
    }

    if (!attributes) {
        return false;
    }

    for (const key of requiredKeys) {
        if (attributes[key] !== matchers[key]) {
            return false;
        }
    }

    return true;
}

/**
 * Whether an incoming OTLP datapoint matches a monitor's selector: the exact
 * same metric name AND every configured attribute matcher.
 * @param {object} monitor A monitor-like object.
 * @param {string} monitor.otel_metric_name The metric name this monitor
 *     wants (e.g. "http.server.request.duration").
 * @param {?string} monitor.otel_attribute_matchers The monitor's attribute
 *     matchers as a JSON STRING column value (e.g. `{"service":"payments"}`),
 *     as it comes straight off the monitor bean/row. Null, undefined, or an
 *     empty string is handled gracefully as "no matchers" (wildcard) -- it
 *     is NOT JSON.parse()'d, since JSON.parse("") and JSON.parse(undefined)
 *     both throw.
 * @param {object} datapoint The incoming datapoint.
 * @param {string} datapoint.metricName The datapoint's metric name.
 * @param {?{[key: string]: string}} datapoint.attributes The datapoint's
 *     merged attributes (plain object, already merged by the caller).
 * @returns {boolean} True only if the metric name matches exactly AND the
 *     parsed attribute matchers match datapoint.attributes.
 */
function metricMatchesMonitor(monitor, datapoint) {
    if (datapoint.metricName !== monitor.otel_metric_name) {
        return false;
    }

    const matchers = monitor.otel_attribute_matchers ? JSON.parse(monitor.otel_attribute_matchers) : null;

    return attributeMatchersMatch(matchers, datapoint.attributes);
}

/**
 * Reduce a set of matched numeric datapoint values down to the single value
 * a monitor's condition should be evaluated against, per the monitor's
 * configured aggregation. This is the response to the ADR's "multiple
 * datapoints per series" concern: when a selector casts a wide enough net to
 * match N series in one ingest batch, this collapses them to one number.
 * @param {number[]} values Non-empty array of numeric datapoint values that
 *     matched one monitor within a single ingest batch.
 * @param {string} aggregation One of "last", "avg", "max", "sum".
 * @returns {number} The aggregated value.
 * @throws {Error} If values is empty (or not an array) -- there is nothing
 *     to aggregate, mirroring computeBaseline()'s empty-array guard in
 *     server/anomaly-detection.js: callers with no matched datapoints are
 *     expected to skip the monitor entirely (see matchDatapointsToMonitors()
 *     below) rather than call this with an empty array.
 * @throws {Error} If aggregation is not one of "last", "avg", "max", "sum" --
 *     fail loud on invalid input, same style as isAnomalous()'s direction
 *     check in server/anomaly-detection.js.
 */
function aggregate(values, aggregation) {
    if (!Array.isArray(values) || values.length === 0) {
        throw new Error("Cannot aggregate an empty values array");
    }

    switch (aggregation) {
        case "last":
            // The last value IN PAYLOAD ORDER, not necessarily the most
            // recent by timestamp -- OTLP datapoints within a single batch
            // are not guaranteed to arrive ordered by time. v1 deliberately
            // keeps this simple (per ADR-0015's consequences section) and
            // documents the limitation here rather than sorting by
            // timestamp.
            return values[values.length - 1];
        case "avg":
            return values.reduce((sum, value) => sum + value, 0) / values.length;
        case "max":
            return Math.max(...values);
        case "sum":
            return values.reduce((sum, value) => sum + value, 0);
        default:
            throw new Error(`Unknown aggregation: ${aggregation}`);
    }
}

/**
 * Default cardinality guard (ADR-0015 "OTLP/protobuf + hardening" step,
 * TASK-A2-4): the maximum number of matched datapoints any ONE monitor will
 * have aggregated for a single ingest batch. A selector that (mis)matches
 * far more series than intended (e.g. an empty/near-empty attribute
 * matcher against a very chatty Collector) must not force this process to
 * hold/aggregate an unbounded array in memory -- see matchDatapointsToMonitors()
 * below for how the cap is applied.
 * @type {number}
 */
const DEFAULT_MAX_MATCHED_DATAPOINTS_PER_MONITOR = 1000;

/**
 * The single entry point the future telemetry router will actually call per
 * ingest batch. For every otel monitor, finds all datapoints whose metric
 * name and attributes match that monitor's selector, aggregates their
 * values per that monitor's configured aggregation, and returns one result
 * per monitor that had at least one match.
 *
 * This is the "selector-first, drop-by-default" cardinality guard from
 * ADR-0015 decision 3, expressed as code shape rather than an explicit
 * filter step: a monitor with zero matching datapoints never gets an entry
 * in the returned array (dropped, not included with a null/zero
 * placeholder), and a datapoint that matches no monitor's selector is never
 * read out of `datapoints` by any iteration, so it is implicitly discarded.
 *
 * On top of that, a second cardinality guard (ADR-0015 "hardening" step,
 * TASK-A2-4) caps how many matched values ANY ONE monitor aggregates in a
 * single call: once a monitor's matched-values buffer reaches
 * `maxMatchedDatapointsPerMonitor`, further matches for that SAME monitor
 * are still counted (`totalMatchedCount`) but no longer pushed into the
 * array that gets aggregated -- so aggregate() only ever runs over an array
 * bounded by the cap, never an unbounded one. The `truncated`/
 * `totalMatchedCount` keys are only present on the returned entry when
 * truncation actually happened, so every existing caller/test that expects
 * the plain `{monitorId, aggregatedValue, matchedCount}` shape for a batch
 * under the cap sees byte-for-byte the same object as before this guard
 * existed.
 * @param {Array<object>} otelMonitors Monitor-like objects, each with `id`,
 *     `otel_metric_name`, `otel_attribute_matchers` (JSON string or
 *     null/empty), and `otel_aggregation` ("last"|"avg"|"max"|"sum").
 * @param {Array<object>} datapoints Already-flattened datapoints, each with
 *     `metricName`, `attributes` (plain object), and `value` (number). This
 *     function does not parse OTLP wire format -- that is a separate
 *     concern for the router to handle before calling this.
 * @param {number} maxMatchedDatapointsPerMonitor The cardinality cap
 *     described above. Defaults to DEFAULT_MAX_MATCHED_DATAPOINTS_PER_MONITOR;
 *     callers (tests, mainly) may pass a smaller number to exercise
 *     truncation without constructing a huge fixture.
 * @returns {Array<{monitorId: number, aggregatedValue: number, matchedCount: number, truncated: (boolean|undefined), totalMatchedCount: (number|undefined)}>}
 *     One entry per monitor with at least one matching datapoint, in the
 *     same order as otelMonitors. Monitors with zero matches are absent.
 *     `truncated`/`totalMatchedCount` are only present when the cap was
 *     actually exceeded for that monitor.
 * @throws {Error} If a monitor's otel_aggregation is not one of "last",
 *     "avg", "max", "sum" (propagated from aggregate()) -- but only for
 *     monitors that actually had at least one matching datapoint, since
 *     aggregate() is never called for a monitor with zero matches.
 */
function matchDatapointsToMonitors(
    otelMonitors,
    datapoints,
    maxMatchedDatapointsPerMonitor = DEFAULT_MAX_MATCHED_DATAPOINTS_PER_MONITOR
) {
    const results = [];

    for (const monitor of otelMonitors) {
        const matchedValues = [];
        let totalMatchedCount = 0;

        for (const datapoint of datapoints) {
            if (metricMatchesMonitor(monitor, datapoint)) {
                totalMatchedCount += 1;
                if (matchedValues.length < maxMatchedDatapointsPerMonitor) {
                    matchedValues.push(datapoint.value);
                }
            }
        }

        if (totalMatchedCount === 0) {
            continue;
        }

        const truncated = totalMatchedCount > matchedValues.length;

        results.push({
            monitorId: monitor.id,
            aggregatedValue: aggregate(matchedValues, monitor.otel_aggregation),
            matchedCount: matchedValues.length,
            ...(truncated ? { truncated: true, totalMatchedCount } : {}),
        });
    }

    return results;
}

module.exports = {
    DEFAULT_MAX_MATCHED_DATAPOINTS_PER_MONITOR,
    attributeMatchersMatch,
    metricMatchesMonitor,
    aggregate,
    matchDatapointsToMonitors,
};
