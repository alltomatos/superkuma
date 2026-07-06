const { MonitorType } = require("./monitor-type");
const { UP, evaluateJsonQuery, log } = require("../../src/util");
const axios = require("axios");
const https = require("https");
const dayjs = require("dayjs");

/**
 * Prometheus monitor: runs a PromQL instant query against a Prometheus server
 * and compares the returned value against a threshold (operator + expected
 * value) to decide UP/DOWN. Lets SuperKuma alert on metrics that Prometheus
 * already collects (CPU/RAM/disk I/O via node_exporter / windows_exporter,
 * SQL Server via mssql_exporter, etc.).
 *
 * Field reuse (no DB migration): `url` = Prometheus base URL,
 * `databaseQuery` = the PromQL expression, `jsonPath`/`jsonPathOperator`/
 * `expectedValue` = the condition (same mechanism as the SNMP monitor),
 * `bearer_token` / `basic_auth_*` = optional auth, `ignoreTls` = self-signed TLS.
 */
class PrometheusMonitorType extends MonitorType {
    name = "prometheus";

    /**
     * Extract a single numeric value from a Prometheus /api/v1/query result.
     * @param {object} data The `data` object from the Prometheus response.
     * @returns {number|string} The scalar value (number when numeric).
     * @throws {Error} If the result is empty or an unsupported type.
     */
    extractValue(data) {
        const resultType = data && data.resultType;
        let raw;

        if (resultType === "scalar" || resultType === "string") {
            // result = [ <timestamp>, "<value>" ]
            raw = data.result[1];
        } else if (resultType === "vector") {
            if (!Array.isArray(data.result) || data.result.length === 0) {
                throw new Error("Prometheus query returned no data (empty vector)");
            }
            // result = [ { metric, value: [ <timestamp>, "<value>" ] }, ... ]
            raw = data.result[0].value[1];
        } else if (resultType === "matrix") {
            throw new Error(
                "Prometheus range (matrix) result is not supported — use an instant query that returns a scalar or a single vector"
            );
        } else {
            throw new Error(`Unsupported Prometheus resultType: ${resultType}`);
        }

        const num = Number(raw);
        return Number.isNaN(num) ? raw : num;
    }

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const base = (monitor.url || "").trim().replace(/\/+$/, "");
        if (!base) {
            throw new Error("Prometheus URL is required");
        }

        const promql = (monitor.databaseQuery || "").trim();
        if (!promql) {
            throw new Error("A PromQL query is required");
        }

        const timeoutSeconds = monitor.timeout > 0 ? monitor.timeout : Math.max(10, Math.floor(monitor.interval * 0.8));

        const options = {
            method: "GET",
            url: `${base}/api/v1/query`,
            params: { query: promql },
            timeout: timeoutSeconds * 1000,
            headers: { Accept: "application/json" },
            // Prometheus returns 400/422 with a JSON error body we want to read.
            validateStatus: () => true,
        };

        if (monitor.ignoreTls) {
            options.httpsAgent = new https.Agent({ rejectUnauthorized: false });
        }

        if (monitor.bearer_token) {
            options.headers.Authorization = `Bearer ${monitor.bearer_token}`;
        } else if (monitor.basic_auth_user) {
            options.auth = { username: monitor.basic_auth_user, password: monitor.basic_auth_pass || "" };
        }

        const startTime = dayjs().valueOf();
        const res = await axios.request(options);
        heartbeat.ping = dayjs().valueOf() - startTime;

        const body = res.data;
        if (!body || body.status !== "success") {
            const detail = (body && (body.error || body.errorType)) || `HTTP ${res.status}`;
            throw new Error(`Prometheus query failed: ${detail}`);
        }

        const value = this.extractValue(body.data);
        log.debug(this.name, `Prometheus value for "${promql}": ${value}`);

        const { status, response } = await evaluateJsonQuery(
            value,
            monitor.jsonPath || "$",
            monitor.jsonPathOperator,
            monitor.expectedValue
        );

        if (status) {
            heartbeat.status = UP;
            heartbeat.msg = `PromQL condition passes (${response} ${monitor.jsonPathOperator} ${monitor.expectedValue})`;
        } else {
            throw new Error(
                `PromQL condition does not pass (${response} ${monitor.jsonPathOperator} ${monitor.expectedValue})`
            );
        }
    }
}

module.exports = {
    PrometheusMonitorType,
};
