const { MonitorType } = require("./monitor-type");
const { UP, evaluateJsonQuery, log } = require("../../src/util");
const Monitor = require("../model/monitor");
const { R } = require("redbean-node");
const axios = require("axios");
const https = require("https");
const dayjs = require("dayjs");

// LogQL range-vector duration suffix, e.g. the "5m" in `[5m]`. Used only to
// size the start/end window sent to /loki/api/v1/query_range -- the actual
// aggregation window is whatever the query author wrote inside the brackets.
const RANGE_DURATION_RE = /\[(\d+)(ms|s|m|h|d|w|y)\]/;
const DURATION_UNIT_MS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000, y: 31536000000 };
const DEFAULT_WINDOW_MS = 5 * 60000;

/**
 * Parse the range-vector duration out of a LogQL query (e.g. `[5m]` -> 300000)
 * so query_range's start/end can cover at least that much history. Falls back
 * to a 5-minute default when the query has no bracketed duration (e.g. a
 * reachability probe query, or a malformed rule -- Loki itself will reject an
 * invalid query with a clear error).
 * @param {string} logql The LogQL expression.
 * @returns {number} The window size in milliseconds.
 */
function parseRangeWindowMs(logql) {
    const match = RANGE_DURATION_RE.exec(logql || "");
    if (!match) {
        return DEFAULT_WINDOW_MS;
    }
    const [, amount, unit] = match;
    return Number(amount) * DUNIT(unit);
}

/**
 * @param {string} unit One of ms|s|m|h|d|w|y.
 * @returns {number} Milliseconds per unit.
 */
function DUNIT(unit) {
    return DURATION_UNIT_MS[unit] || DURATION_UNIT_MS.m;
}

/**
 * Extract a single numeric value from a Loki /loki/api/v1/query_range result.
 * v1 only supports scalar/vector results from an aggregating LogQL query
 * (e.g. `count_over_time(...)`, `sum(...)`) -- raw log lines (`streams`) are
 * deliberately rejected, matching prometheus.js's rejection of `matrix`: this
 * monitor type never stores or evaluates raw log content, only the number a
 * LogQL aggregation already reduced it to.
 * @param {object} data The `data` object from the Loki response.
 * @returns {number|string} The scalar value (number when numeric).
 * @throws {Error} If the result is empty or an unsupported type.
 */
function extractLokiValue(data) {
    const resultType = data && data.resultType;
    let raw;

    if (resultType === "scalar") {
        // result = [ <timestamp>, "<value>" ]
        raw = data.result[1];
    } else if (resultType === "vector") {
        if (!Array.isArray(data.result) || data.result.length === 0) {
            throw new Error("Loki query returned no data (empty vector)");
        }
        // result = [ { metric, value: [ <timestamp>, "<value>" ] }, ... ]
        raw = data.result[0].value[1];
    } else if (resultType === "matrix") {
        // result = [ { metric, values: [[<ts>,"<value>"], ...] }, ... ] -- take
        // the most recent sample of the first series, same intent as a vector.
        if (!Array.isArray(data.result) || data.result.length === 0 || !data.result[0].values?.length) {
            throw new Error("Loki query returned no data (empty matrix)");
        }
        const series = data.result[0].values;
        raw = series[series.length - 1][1];
    } else if (resultType === "streams") {
        throw new Error(
            "Loki log-line (streams) result is not supported — use an aggregating query like count_over_time() that returns a number"
        );
    } else {
        throw new Error(`Unsupported Loki resultType: ${resultType}`);
    }

    const num = Number(raw);
    return Number.isNaN(num) ? raw : num;
}

/**
 * Loki monitor: reachability decides the monitor's own UP/DOWN heartbeat,
 * exactly like every other pull monitor type. Separately, and without ever
 * affecting that heartbeat, every enabled `monitor_log_rule` attached to this
 * monitor is evaluated against Loki and any rule that trips raises its own
 * `alert_event` (ADR-0013's alert_event pattern) routed through the existing
 * severity/notification-routing pipeline (ADR-0014) -- unchanged.
 *
 * Field reuse (no new monitor columns beyond `loki_reachability_query`):
 * `url` = Loki base URL, `bearer_token` / `basic_auth_*` = optional auth
 * (Loki has no native auth; these are for a reverse proxy in front of it),
 * `ignoreTls` = self-signed TLS -- identical fields/semantics to
 * prometheus.js.
 */
class LokiMonitorType extends MonitorType {
    name = "loki";

    /**
     * Build the shared axios request options (auth, TLS, timeout) common to
     * every Loki HTTP call this monitor type makes.
     * @param {Monitor} monitor The monitor being checked.
     * @returns {object} Partial axios request options.
     */
    buildRequestOptions(monitor) {
        const timeoutSeconds = monitor.timeout > 0 ? monitor.timeout : Math.max(10, Math.floor(monitor.interval * 0.8));
        const options = {
            timeout: timeoutSeconds * 1000,
            headers: { Accept: "application/json" },
            // Loki returns 400 with a JSON error body on a bad LogQL query; read it.
            validateStatus: () => true,
        };

        if (monitor.ignoreTls) {
            // codeql[js/disabling-certificate-validation]: deliberate, user opt-in
            // (off by default) for self-signed certs on an internal Loki --
            // identical, already-accepted pattern to prometheus.js/influxdb.js's
            // own ignoreTls handling.
            options.httpsAgent = new https.Agent({ rejectUnauthorized: false });
        }

        if (monitor.bearer_token) {
            options.headers.Authorization = `Bearer ${monitor.bearer_token}`;
        } else if (monitor.basic_auth_user) {
            options.auth = { username: monitor.basic_auth_user, password: monitor.basic_auth_pass || "" };
        }

        return options;
    }

    /**
     * Run one LogQL query_range call and return its extracted numeric value.
     * @param {string} base Loki base URL (no trailing slash).
     * @param {string} logql The LogQL expression to run.
     * @param {object} baseOptions Shared axios options from buildRequestOptions().
     * @returns {Promise<number|string>} The extracted value.
     * @throws {Error} If the request fails or the response is unusable.
     */
    async runQuery(base, logql, baseOptions) {
        const windowMs = parseRangeWindowMs(logql);
        const end = dayjs().valueOf();
        const start = end - windowMs;

        const res = await axios.request({
            ...baseOptions,
            method: "GET",
            url: `${base}/loki/api/v1/query_range`,
            params: {
                query: logql,
                start: `${start}000000`, // ms -> ns
                end: `${end}000000`,
            },
        });

        const body = res.data;
        if (!body || body.status !== "success") {
            const detail = (body && (body.error || body.errorType)) || `HTTP ${res.status}`;
            throw new Error(`Loki query failed: ${detail}`);
        }

        return extractLokiValue(body.data);
    }

    /**
     * Evaluate every enabled log rule attached to this monitor. Never throws
     * -- a broken rule (bad LogQL, unreachable mid-check, etc.) is logged and
     * skipped, it must never take down the other rules or the monitor's own
     * heartbeat (mirrors Monitor.evaluateAnomaly's swallow-everything
     * contract for the same reason).
     * @param {Monitor} monitor The monitor being checked.
     * @param {Heartbeat} heartbeat This beat's heartbeat (read-only here).
     * @param {string} base Loki base URL (no trailing slash).
     * @param {object} baseOptions Shared axios options from buildRequestOptions().
     * @returns {Promise<{evaluated: number, triggered: number}>} Summary counts for heartbeat.msg.
     */
    async evaluateRules(monitor, heartbeat, base, baseOptions) {
        const rules = await R.find("monitor_log_rule", "monitor_id = ? AND enabled = ?", [monitor.id, true]);

        const results = await Promise.allSettled(
            rules.map(async (rule) => {
                const value = await this.runQuery(base, rule.logql, baseOptions);
                const { status, response } = await evaluateJsonQuery(value, "$", rule.operator, rule.threshold);
                if (status) {
                    await Monitor.evaluateLogRule(monitor, heartbeat, rule, response);
                }
                return status;
            })
        );

        for (const result of results) {
            if (result.status === "rejected") {
                log.warn(
                    this.name,
                    `Log rule evaluation failed for monitor ${monitor.id}: ${result.reason?.message || result.reason}`
                );
            }
        }

        const evaluated = results.length;
        const triggered = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
        return { evaluated, triggered };
    }

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const base = (monitor.url || "").trim().replace(/\/+$/, "");
        if (!base) {
            throw new Error("Loki URL is required");
        }

        const options = this.buildRequestOptions(monitor);
        const startTime = dayjs().valueOf();

        // Phase A: reachability. This is the ONLY thing that can set the
        // heartbeat DOWN -- a log rule tripping is an alert, not an outage.
        const reachabilityQuery = (monitor.loki_reachability_query || "").trim();
        if (reachabilityQuery) {
            const body = await (async () => {
                const res = await axios.request({
                    ...options,
                    method: "GET",
                    url: `${base}/loki/api/v1/query_range`,
                    params: {
                        query: reachabilityQuery,
                        start: `${dayjs().valueOf() - parseRangeWindowMs(reachabilityQuery)}000000`,
                        end: `${dayjs().valueOf()}000000`,
                    },
                });
                return res;
            })();
            if (!body.data || body.data.status !== "success") {
                const detail = (body.data && (body.data.error || body.data.errorType)) || `HTTP ${body.status}`;
                throw new Error(`Loki reachability query failed: ${detail}`);
            }
        } else {
            const res = await axios.request({ ...options, method: "GET", url: `${base}/ready` });
            if (res.status !== 200) {
                throw new Error(`Loki is not ready (HTTP ${res.status})`);
            }
        }

        heartbeat.ping = dayjs().valueOf() - startTime;
        heartbeat.status = UP;

        // Phase B: rule evaluation. Runs after the heartbeat is already
        // decided and never mutates heartbeat.status.
        const { evaluated, triggered } = await this.evaluateRules(monitor, heartbeat, base, options);
        heartbeat.msg =
            evaluated === 0 ? "Loki reachable" : `Loki reachable — ${triggered}/${evaluated} log rules triggered`;
    }
}

module.exports = {
    LokiMonitorType,
    extractLokiValue,
    parseRangeWindowMs,
};
