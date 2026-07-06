// Mirrors Heartbeat.extractPublicMetricValue (server/model/heartbeat.js) -- the
// dashboard is authenticated so `msg` isn't stripped like it is for public
// status pages, so this reads the same self-authored message format directly
// instead of adding a redundant server round-trip. Shared by MetricValueChart.vue
// and the monitor Details page's stat boxes so both stay in sync.
const METRIC_VALUE_RE = /^PromQL condition (?:passes|does not pass) \(([-\d.eE+]+)\s/;

/**
 * Extract the numeric PromQL result from a prometheus monitor's heartbeat message.
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
