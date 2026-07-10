// Mirrors Heartbeat.extractPublicMetricValue (server/model/heartbeat.js) -- the
// dashboard is authenticated so `msg` isn't stripped like it is for public
// status pages, so this reads the same self-authored message format directly
// instead of adding a redundant server round-trip. Shared by MetricValueChart.vue
// and the monitor Details page's stat boxes so both stay in sync.
//
// Self-authored formats that carry a numeric measurement against a threshold:
//   prometheus:            "PromQL condition passes (<value> <op> <expected>)"
//   influxdb:              "InfluxQL condition passes (<value> <op> <expected>)"
//   snmp / json-query:     "JSON query passes (comparing <value> <op> <expected>)"
// Non-numeric comparisons (e.g. string json-query) simply don't match, so those
// monitors keep their normal (non-metric) display.
const METRIC_VALUE_RE =
    /^(?:PromQL condition (?:passes|does not pass) \(|InfluxQL condition (?:passes|does not pass) \(|JSON query (?:passes|does not pass) \(comparing )([-\d.eE+]+)\s/;

// Monitor types whose heartbeat can carry an extractable numeric metric value.
const METRIC_MONITOR_TYPES = ["prometheus", "influxdb", "snmp", "json-query"];

/**
 * Whether a monitor type can carry a numeric metric (gauge/chart/unit) at all.
 * @param {string} type The monitor's type
 * @returns {boolean} True for prometheus/influxdb/snmp/json-query
 */
export function isMetricMonitorType(type) {
    return METRIC_MONITOR_TYPES.includes(type);
}

/**
 * Extract the numeric result from a metric monitor's heartbeat message
 * (prometheus, influxdb, snmp or json-query -- see METRIC_VALUE_RE).
 * @param {string} msg The heartbeat's message
 * @returns {number|null} The numeric value, or null if not recognized
 */
export function extractMetricValue(msg) {
    const match = METRIC_VALUE_RE.exec(msg || "");
    if (!match) {
        return null;
    }
    const value = Number(match[1]);
    return Number.isNaN(value) ? null : value;
}
