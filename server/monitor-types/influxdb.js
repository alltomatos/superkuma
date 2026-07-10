const { MonitorType } = require("./monitor-type");
const { UP, evaluateJsonQuery, log } = require("../../src/util");
const axios = require("axios");
const https = require("https");
const dayjs = require("dayjs");

/**
 * InfluxDB monitor: runs an InfluxQL query against an InfluxDB v1 server and
 * compares the returned value against a threshold (operator + expected value)
 * to decide UP/DOWN. It is the storage-backed dual of the Prometheus monitor —
 * where `prometheus` queries a Prometheus that scrapes, `influxdb` queries an
 * InfluxDB that agents *push* to. The primary use case is alerting on metrics
 * that Telegraf already writes to InfluxDB, e.g. a pfSense firewall reporting
 * CPU/load/memory/packet-loss/gateway-RTT/WAN-throughput via the pfSense
 * Telegraf package's InfluxDB output.
 *
 * Field reuse (one new column, `influxdb_database`): `url` = InfluxDB base URL,
 * `influxdbDatabase` = the target database (the `db` query param InfluxDB v1
 * requires), `databaseQuery` = the InfluxQL expression, `jsonPathOperator` +
 * `expectedValue` = the condition (the result is a scalar, so `jsonPath` is
 * fixed to `$` — same `evaluateJsonQuery` mechanism as the SNMP/Prometheus
 * monitors). Auth: prefer `basic_auth_user`/`basic_auth_pass` (HTTP Basic --
 * InfluxDB v1's recommended production auth). `bearer_token` is also accepted
 * and sent as `Authorization: Token <value>`, but note InfluxDB v1's "Token"
 * scheme expects the literal `username:password` string, NOT an opaque v2-style
 * API token -- it exists mainly for parity with the `prometheus` monitor and
 * v2-compatible setups; for a plain v1 instance, Basic auth is simpler and
 * unambiguous. `ignoreTls` for self-signed TLS.
 */
class InfluxDbMonitorType extends MonitorType {
    name = "influxdb";

    /**
     * Extract a single numeric value from an InfluxDB v1 `/query` result.
     * InfluxQL returns `{ results: [ { series: [ { columns, values } ] } ] }`;
     * we take the last column of the last row — the value of a single-value
     * SELECT such as `last(...)` / `mean(...)` (column 0 is always the time).
     * @param {object} body The parsed JSON body from the InfluxDB response.
     * @returns {number|string} The scalar value (number when numeric).
     * @throws {Error} If the query errored or returned no data.
     */
    extractValue(body) {
        if (!body || typeof body !== "object") {
            throw new Error("InfluxDB returned an empty or non-JSON response");
        }
        // Top-level parse/auth errors come back as { error: "..." }.
        if (body.error) {
            throw new Error(`InfluxDB query failed: ${body.error}`);
        }

        const results = Array.isArray(body.results) ? body.results : [];
        const first = results[0];
        if (!first) {
            throw new Error("InfluxDB query returned no results");
        }
        // A per-statement error (e.g. invalid InfluxQL) is nested here.
        if (first.error) {
            throw new Error(`InfluxDB query failed: ${first.error}`);
        }

        const series = Array.isArray(first.series) ? first.series : [];
        if (series.length === 0) {
            throw new Error(
                "InfluxDB query returned no data (empty series) — check the measurement, tags and time range"
            );
        }

        const values = Array.isArray(series[0].values) ? series[0].values : [];
        if (values.length === 0) {
            throw new Error("InfluxDB query returned no data points (empty series values)");
        }

        const lastRow = values[values.length - 1];
        if (!Array.isArray(lastRow) || lastRow.length === 0) {
            throw new Error("InfluxDB query returned an unexpected row shape");
        }

        // Column 0 is the timestamp; the value is the last selected column.
        const raw = lastRow[lastRow.length - 1];
        const num = Number(raw);
        return Number.isNaN(num) ? raw : num;
    }

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const base = (monitor.url || "").trim().replace(/\/+$/, "");
        if (!base) {
            throw new Error("InfluxDB URL is required");
        }

        const database = (monitor.influxdbDatabase || "").trim();
        if (!database) {
            throw new Error("An InfluxDB database is required");
        }

        const influxql = (monitor.databaseQuery || "").trim();
        if (!influxql) {
            throw new Error("An InfluxQL query is required");
        }

        const timeoutSeconds = monitor.timeout > 0 ? monitor.timeout : Math.max(10, Math.floor(monitor.interval * 0.8));

        const options = {
            method: "GET",
            url: `${base}/query`,
            params: {
                db: database,
                q: influxql,
                epoch: "ms",
            },
            timeout: timeoutSeconds * 1000,
            headers: { Accept: "application/json" },
            // InfluxDB returns 400/401 with a JSON error body we want to read.
            validateStatus: () => true,
        };

        if (monitor.ignoreTls) {
            options.httpsAgent = new https.Agent({ rejectUnauthorized: false });
        }

        if (monitor.bearer_token) {
            // InfluxDB 1.8+ and 2.x authenticate with `Token`, not `Bearer`.
            options.headers.Authorization = `Token ${monitor.bearer_token}`;
        } else if (monitor.basic_auth_user) {
            options.auth = { username: monitor.basic_auth_user, password: monitor.basic_auth_pass || "" };
        }

        const startTime = dayjs().valueOf();
        const res = await axios.request(options);
        heartbeat.ping = dayjs().valueOf() - startTime;

        if (res.status < 200 || res.status >= 300) {
            const detail = (res.data && res.data.error) || `HTTP ${res.status}`;
            throw new Error(`InfluxDB query failed: ${detail}`);
        }

        const value = this.extractValue(res.data);
        log.debug(this.name, `InfluxDB value for "${influxql}": ${value}`);

        const { status, response } = await evaluateJsonQuery(
            value,
            "$",
            monitor.jsonPathOperator,
            monitor.expectedValue
        );

        if (status) {
            heartbeat.status = UP;
            heartbeat.msg = `InfluxQL condition passes (${response} ${monitor.jsonPathOperator} ${monitor.expectedValue})`;
        } else {
            throw new Error(
                `InfluxQL condition does not pass (${response} ${monitor.jsonPathOperator} ${monitor.expectedValue})`
            );
        }
    }
}

module.exports = {
    InfluxDbMonitorType,
};
