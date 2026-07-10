let express = require("express");
const { R } = require("redbean-node");
const dayjs = require("dayjs");
const Monitor = require("../model/monitor");
const { UP, DOWN, MAINTENANCE, evaluateJsonQuery, log } = require("../../src/util");
const { SuperKumaServer } = require("../superkuma-server");
const { Prometheus } = require("../prometheus");
const { UptimeCalculator } = require("../uptime-calculator");
const { roomFor } = require("../security/rooms");
const { matchDatapointsToMonitors } = require("../otel-selector");

/**
 * OTLP/JSON telemetry receiver (ADR-0015, TASK-A2-2): `POST /v1/metrics`.
 * The fourth ingestion adapter alongside pull (`prometheus`), push-heartbeat
 * (`push`), and federation -- an OTel Collector/SDK pushes a batch of
 * metrics here instead of SuperKuma pulling them. Team-scoped bearer-token
 * auth (`team.otel_ingest_token`), no `checkLogin`/socket involved -- this is
 * a public-but-authenticated surface, same posture as `/api/push/:pushToken`
 * and `/api/federation/heartbeat`.
 *
 * Never persists raw telemetry (ADR-0015 decision 2): every datapoint in the
 * batch is matched against the team's `type = 'otel'` monitors
 * (server/otel-selector.js, "selector-first, drop-by-default") and only
 * datapoints that match at least one monitor ever produce a heartbeat: the
 * rest are read once and discarded, never written anywhere.
 */

let router = express.Router();

const server = SuperKumaServer.getInstance();
let io = server.io;

/**
 * Extract the bearer token from the Authorization header. Unlike
 * federation-router.js's extractToken(), this deliberately does NOT fall
 * back to a `request.body.token` field -- real OTLP exporters/collectors
 * always authenticate via the standard `Authorization: Bearer <token>`
 * header (OTLP/HTTP spec), and the request body here is the
 * ExportMetricsServiceRequest payload itself, not a place to smuggle a token.
 * @param {express.Request} request Express request object.
 * @returns {?string} The token, or null if the header is absent/malformed.
 */
function extractBearerToken(request) {
    const authHeader = request.headers && request.headers["authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        return authHeader.substring("Bearer ".length).trim();
    }
    return null;
}

/**
 * Coerce an OTLP attribute value union (`{stringValue}` | `{intValue}` |
 * `{doubleValue}` | `{boolValue}`) to a plain string, for exact-string-match
 * comparison against a monitor's `otel_attribute_matchers`
 * (server/otel-selector.js's attributeMatchersMatch() is exact string
 * equality, so every value kind is normalized to a string here rather than
 * kept as its native JS type).
 * @param {?object} value An OTLP AnyValue object, e.g. `{"stringValue": "x"}`.
 * @returns {string} The value coerced to a string ("" if value is nullish or
 *     none of the known kinds are present).
 */
function attributeValueToString(value) {
    if (value === null || value === undefined || typeof value !== "object") {
        return "";
    }
    if ("stringValue" in value) {
        return String(value.stringValue);
    }
    if ("intValue" in value) {
        return String(value.intValue);
    }
    if ("doubleValue" in value) {
        return String(value.doubleValue);
    }
    if ("boolValue" in value) {
        return String(value.boolValue);
    }
    return "";
}

/**
 * Flatten an OTLP `attributes` array (`[{key, value}, ...]`) into a plain
 * `{key: stringifiedValue}` object, the shape server/otel-selector.js's
 * attributeMatchersMatch() expects.
 * @param {?Array<{key: string, value: object}>} attributesArray An OTLP
 *     KeyValue array, or anything falsy/non-array (treated as empty).
 * @returns {{[key: string]: string}} The flattened attributes object.
 */
function flattenAttributes(attributesArray) {
    const result = {};
    if (!Array.isArray(attributesArray)) {
        return result;
    }
    for (const attribute of attributesArray) {
        if (attribute && typeof attribute.key === "string") {
            result[attribute.key] = attributeValueToString(attribute.value);
        }
    }
    return result;
}

/**
 * Extract a datapoint's numeric value, preferring `asDouble` and falling
 * back to `asInt` (parsed as a Number), per the OTLP NumberDataPoint union.
 * @param {?object} dataPoint A single OTLP NumberDataPoint object.
 * @returns {?number} The numeric value, or null if neither field is present
 *     or the value fails to parse to a finite number (the datapoint is then
 *     skipped by the caller rather than corrupting an aggregation with NaN).
 */
function extractDatapointValue(dataPoint) {
    if (!dataPoint) {
        return null;
    }
    let raw;
    if (dataPoint.asDouble !== undefined && dataPoint.asDouble !== null) {
        raw = dataPoint.asDouble;
    } else if (dataPoint.asInt !== undefined && dataPoint.asInt !== null) {
        raw = dataPoint.asInt;
    } else {
        return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

/**
 * Parse an OTLP/JSON ExportMetricsServiceRequest body into a flat array of
 * `{metricName, attributes, value}` datapoints, ready for
 * matchDatapointsToMonitors(). Resource-level attributes are merged into
 * every datapoint under that resource (lower precedence -- a datapoint's own
 * attributes win on key collision, per the OTLP semantic convention that
 * more specific/local attributes override broader ones).
 *
 * v1 scope (ADR-0015): only `gauge` and `sum` metric shapes are supported.
 * A metrics[] entry that is none of those (histogram, summary,
 * exponentialHistogram) is skipped silently -- one unsupported metric type
 * in a batch must never fail the whole batch.
 * @param {*} body The parsed request body (whatever request.body currently
 *     holds -- may be anything if the caller sent a non-OTLP payload).
 * @returns {Array<{metricName: string, attributes: {[key: string]: string}, value: number}>}
 *     The flattened datapoints, in payload order.
 * @throws {Error} If body is not a plain object, or body.resourceMetrics is
 *     not an array -- there is nothing OTLP-shaped to read.
 */
function extractDatapoints(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Request body must be a JSON object");
    }

    if (!Array.isArray(body.resourceMetrics)) {
        throw new Error("Request body must contain a resourceMetrics array (OTLP/JSON ExportMetricsServiceRequest)");
    }

    const datapoints = [];

    for (const resourceMetric of body.resourceMetrics) {
        const resourceAttributes = flattenAttributes(resourceMetric?.resource?.attributes);
        const scopeMetrics = Array.isArray(resourceMetric?.scopeMetrics) ? resourceMetric.scopeMetrics : [];

        for (const scopeMetric of scopeMetrics) {
            const metrics = Array.isArray(scopeMetric?.metrics) ? scopeMetric.metrics : [];

            for (const metric of metrics) {
                // Support both `gauge` and `sum` -- both carry the same
                // dataPoints[] shape per the OTLP spec. Anything else
                // (histogram/summary/exponentialHistogram) is out of scope
                // for v1 and is dropped here, not errored.
                const container = metric?.gauge || metric?.sum;
                if (!container || !Array.isArray(container.dataPoints)) {
                    continue;
                }

                for (const dataPoint of container.dataPoints) {
                    const value = extractDatapointValue(dataPoint);
                    if (value === null) {
                        continue;
                    }

                    datapoints.push({
                        metricName: metric.name,
                        attributes: {
                            ...resourceAttributes,
                            ...flattenAttributes(dataPoint?.attributes),
                        },
                        value,
                    });
                }
            }
        }
    }

    return datapoints;
}

/**
 * Process one matched otel monitor's aggregated value as an independent
 * heartbeat: maintenance check, threshold evaluation via evaluateJsonQuery
 * (mirroring server/monitor-types/prometheus.js's calling convention),
 * UptimeCalculator update, anomaly evaluation (ADR-0013, same ordering as
 * Monitor.prototype.start()'s beat() closure -- right after the
 * UptimeCalculator update), the isFirstBeat/important/resendInterval
 * notification dance (copied from api-router.js's push handler), heartbeat
 * persistence, socket emit, stats, and a best-effort Prometheus exporter
 * update.
 *
 * Unlike monitor-types/prometheus.js's check() (a plugin whose check() is
 * wrapped by an outer try/catch inside beat(), so it signals DOWN by
 * throwing), this function sets bean.status directly: this router's own
 * handler is the top-level try/catch here (same posture as api-router.js's
 * push handler and federation-router.js's heartbeat handler), not a plugin
 * dispatched through that machinery.
 * @param {Monitor} monitor The full monitor bean (already loaded, otel_*
 *     selector fields present) this aggregated value matched.
 * @param {number} aggregatedValue The value produced by
 *     server/otel-selector.js's aggregate() for this monitor in this batch.
 * @returns {Promise<void>}
 */
async function processOtelMonitorBeat(monitor, aggregatedValue) {
    const previousHeartbeat = await Monitor.getPreviousHeartbeat(monitor.id);
    const isFirstBeat = !previousHeartbeat;

    let bean = R.dispense("heartbeat");
    bean.time = R.isoDateTimeMillis(dayjs.utc());
    bean.monitor_id = monitor.id;
    // Same channel `ping`/`value` already feed for push monitors (TASK-A2-1) --
    // reduction-at-ingest per ADR-0015 decision 2, no new heartbeat column.
    bean.ping = aggregatedValue;
    bean.downCount = previousHeartbeat?.downCount || 0;

    if (previousHeartbeat) {
        bean.duration = dayjs(bean.time).diff(dayjs(previousHeartbeat.time), "second");
    }

    if (await Monitor.isUnderMaintenance(monitor.id)) {
        bean.msg = "Monitor under maintenance";
        bean.status = MAINTENANCE;
    } else {
        const { status, response } = await evaluateJsonQuery(
            aggregatedValue,
            monitor.jsonPath || "$",
            monitor.jsonPathOperator,
            monitor.expectedValue
        );

        if (status) {
            bean.status = UP;
            bean.msg = `OTel condition passes (${response} ${monitor.jsonPathOperator} ${monitor.expectedValue})`;
        } else {
            bean.status = DOWN;
            bean.msg = `OTel condition does not pass (${response} ${monitor.jsonPathOperator} ${monitor.expectedValue})`;
        }
    }

    // Calculate uptime
    let uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitor.id);
    let endTimeDayjs = await uptimeCalculator.update(bean.status, parseFloat(bean.ping));
    bean.end_time = R.isoDateTimeMillis(endTimeDayjs);

    // Evaluate response-time... well, metric-value anomaly (ADR-0013) --
    // must run right after uptimeCalculator.update(), same ordering
    // Monitor.prototype.start()'s beat() closure established (TASK-A1-3),
    // characterized by test-uptime-calculator-anomaly-window.js (TASK-A1-0).
    await Monitor.evaluateAnomaly(monitor, bean, uptimeCalculator);

    bean.important = Monitor.isImportantBeat(isFirstBeat, previousHeartbeat?.status, bean.status);

    if (Monitor.isImportantForNotification(isFirstBeat, previousHeartbeat?.status, bean.status)) {
        // Reset down count
        bean.downCount = 0;

        log.debug("telemetry", `[${monitor.name}] sendNotification`);
        await Monitor.sendNotification(isFirstBeat, monitor, bean);
    } else if (bean.status === DOWN && monitor.resendInterval > 0) {
        ++bean.downCount;
        if (bean.downCount >= monitor.resendInterval) {
            // Send notification again, because we are still DOWN
            log.debug(
                "telemetry",
                `[${monitor.name}] sendNotification again: Down Count: ${bean.downCount} | Resend Interval: ${monitor.resendInterval}`
            );
            await Monitor.sendNotification(isFirstBeat, monitor, bean);

            // Reset down count
            bean.downCount = 0;
        }
    }

    await R.store(bean);

    io.to(roomFor(monitor.user_id, monitor.team_id)).emit("heartbeat", bean.toJSON());

    Monitor.sendStats(io, monitor.id, monitor.user_id, monitor.team_id);

    try {
        new Prometheus(monitor, await monitor.getTags()).update(bean, undefined);
    } catch (e) {
        log.error("prometheus", "Please submit an issue to our GitHub repo. Prometheus update error: ", e.message);
    }
}

router.post("/v1/metrics", async (request, response) => {
    try {
        const token = extractBearerToken(request);
        const team = token ? await R.findOne("team", " otel_ingest_token = ? ", [token]) : null;

        if (!team) {
            response.status(401).json({
                ok: false,
                msg: "Missing or invalid Authorization token.",
            });
            return;
        }

        // Throws on a malformed/non-OTLP body -- caught below, mapped to 400.
        const datapoints = extractDatapoints(request.body);

        const otelMonitors = await R.find("monitor", " team_id = ? AND type = 'otel' AND active = 1 ", [team.id]);
        // matchDatapointsToMonitors() only needs id/otel_*/aggregation off each
        // monitor and returns {monitorId, aggregatedValue, matchedCount} --
        // keep the already-loaded full beans around by id so each match can be
        // processed as a heartbeat without a redundant per-monitor reload.
        const monitorById = new Map(otelMonitors.map((monitor) => [monitor.id, monitor]));

        const matches = matchDatapointsToMonitors(otelMonitors, datapoints);

        for (const match of matches) {
            const monitor = monitorById.get(match.monitorId);
            if (!monitor) {
                continue;
            }

            try {
                await processOtelMonitorBeat(monitor, match.aggregatedValue);
            } catch (e) {
                // One monitor's bad config (or a transient error while
                // processing it) must never abort the rest of the batch --
                // every OTHER matched monitor still gets its heartbeat.
                log.error("telemetry", `[monitor ${monitor.id}] otel beat processing failed: ${e.message}`);
            }
        }

        // Empty ExportMetricsServiceResponse == full success. Partial-failure
        // reporting is explicitly out of scope for v1 (ADR-0015).
        response.json({});
    } catch (e) {
        response.status(400).json({
            ok: false,
            msg: e.message,
        });
    }
});

module.exports = router;
