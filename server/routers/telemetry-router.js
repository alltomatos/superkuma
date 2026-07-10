let express = require("express");
const path = require("path");
const protobuf = require("protobufjs");
const { R } = require("redbean-node");
const dayjs = require("dayjs");
const Monitor = require("../model/monitor");
const { UP, DOWN, MAINTENANCE, evaluateJsonQuery, log } = require("../../src/util");
const { SuperKumaServer } = require("../superkuma-server");
const { Prometheus } = require("../prometheus");
const { UptimeCalculator } = require("../uptime-calculator");
const { roomFor } = require("../security/rooms");
const { matchDatapointsToMonitors, DEFAULT_MAX_MATCHED_DATAPOINTS_PER_MONITOR } = require("../otel-selector");
const { KumaRateLimiter } = require("../rate-limiter");

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
 *
 * TASK-A2-4 additive hardening on top of the above (all documented next to
 * their own definitions below): OTLP/protobuf support (a second, binary
 * encoding of the exact same ExportMetricsServiceRequest), a per-team rate
 * limiter, a route-specific payload size cap for both content-types, and a
 * per-monitor cardinality cap on matched datapoints within one batch.
 */

let router = express.Router();

const server = SuperKumaServer.getInstance();
let io = server.io;

/**
 * The parsed .proto Root for this receiver's binary OTLP support
 * (TASK-A2-4). Loaded once at module load time -- schema parsing is pure CPU
 * work with no I/O beyond reading this one bundled file, so there is no
 * benefit to re-parsing it per request the way protobuf.parse() is used
 * ad-hoc in server/monitor-types/grpc.js (there, the .proto text is
 * user-supplied monitor config that can change at any time; here it is a
 * fixed file shipped with the app).
 * @type {protobuf.Root}
 */
const otlpProtoRoot = protobuf.loadSync(path.join(__dirname, "..", "otlp-proto", "metrics.proto"));

/**
 * The protobuf message Type for the OTLP metrics export request -- see
 * server/otlp-proto/metrics.proto for the (deliberately minimal) schema.
 * @type {protobuf.Type}
 */
const ExportMetricsServiceRequestType = otlpProtoRoot.lookupType(
    "superkuma.otlp.metrics.v1.ExportMetricsServiceRequest"
);

/**
 * Route-specific payload size cap (ADR-0015 hardening step), enforced by
 * express.json()/express.raw()'s own `limit` option for THIS route only --
 * see the `express.raw()`/`express.json()` middleware wired into
 * `router.post("/v1/metrics", ...)` below, and the matching change to the
 * app-wide `express.json()` registration in server.js (this route is
 * excluded from that app-wide parser, precisely so ITS default/smaller limit
 * can never preempt this one).
 * @type {number}
 */
const MAX_TELEMETRY_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * Per-monitor cardinality cap (ADR-0015 hardening step) -- see
 * server/otel-selector.js's matchDatapointsToMonitors() for the actual
 * truncation logic. Re-exported here under the router's own name only for
 * readability at the call site below; same value as the selector's default.
 * @type {number}
 */
const MAX_MATCHED_DATAPOINTS_PER_MONITOR = DEFAULT_MAX_MATCHED_DATAPOINTS_PER_MONITOR;

/**
 * Per-team token-bucket rate limiter (ADR-0015 hardening step). A single
 * GLOBAL KumaRateLimiter (like loginRateLimiter/apiRateLimiter in
 * server/rate-limiter.js) would let one team's legitimately high-frequency
 * ingest starve every other team's telemetry -- so instead this lazily
 * creates one independent KumaRateLimiter per team_id on first use. Twice
 * apiRateLimiter's cadence (120/min vs 60/min): telemetry ingest is
 * legitimately higher-frequency than interactive API calls, but still
 * bounded, not unlimited.
 * @type {Map<number, KumaRateLimiter>}
 */
const telemetryRateLimiterByTeam = new Map();

const TELEMETRY_RATE_LIMIT_TOKENS_PER_INTERVAL = 120;
const TELEMETRY_RATE_LIMIT_INTERVAL = "minute";

/**
 * Get (lazily creating on first use) the KumaRateLimiter instance for one
 * team. Never removed/expired -- same lifetime posture as the existing
 * module-level singleton limiters in server/rate-limiter.js, just one per
 * team instead of one for the whole process.
 * @param {number} teamId The team's id.
 * @returns {KumaRateLimiter} That team's rate limiter.
 */
function getTelemetryRateLimiterForTeam(teamId) {
    let limiter = telemetryRateLimiterByTeam.get(teamId);
    if (!limiter) {
        limiter = new KumaRateLimiter({
            tokensPerInterval: TELEMETRY_RATE_LIMIT_TOKENS_PER_INTERVAL,
            interval: TELEMETRY_RATE_LIMIT_INTERVAL,
            fireImmediately: true,
            errorMessage: "Too many telemetry requests for this team, try again later.",
        });
        telemetryRateLimiterByTeam.set(teamId, limiter);
    }
    return limiter;
}

/**
 * Whether a request's Content-Type header identifies an OTLP/protobuf body.
 * Per the task's spec: any content-type containing "protobuf" (case
 * notwithstanding) -- not just the canonical "application/x-protobuf" -- is
 * treated as binary OTLP. Anything else (including a missing header) falls
 * through to the OTLP/JSON path, matching today's implicit default.
 * @param {*} contentType The raw `request.headers["content-type"]` value.
 * @returns {boolean} True if this should be decoded as binary OTLP/protobuf.
 */
function isProtobufContentType(contentType) {
    return typeof contentType === "string" && /protobuf/i.test(contentType);
}

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
 * Decode a binary-encoded OTLP `ExportMetricsServiceRequest`
 * (`application/x-protobuf`, TASK-A2-4) into the exact same plain-object
 * shape `extractDatapoints()` already parses from OTLP/JSON -- so the SAME
 * `extractDatapoints()` function (no protobuf-specific duplicate) can be
 * called on the result.
 *
 * This relies on `protobuf.Type#toObject()`'s conversion options, verified
 * empirically against real encoded fixtures (see the ADR-0015 TASK-A2-4
 * design notes) rather than assumed:
 *   - `longs: Number` -- OTLP's `fixed64`/`sfixed64` fields (only `as_int`
 *     matters here) decode as protobufjs `Long` instances by default, which
 *     do NOT coerce to a JS number via `Number()`/arithmetic the way
 *     extractDatapointValue() expects; `longs: Number` makes toObject()
 *     emit a plain JS number instead (precision loss above 2^53, an
 *     accepted trade-off already implicit in extractDatapointValue()'s own
 *     `Number(raw)` cast on the JSON path).
 *   - `defaults: false` -- WITHOUT this, a decoded protobuf Message
 *     instance answers `"stringValue" in value` as `true` for EVERY oneof
 *     member of AnyValue (string_value/bool_value/int_value/double_value),
 *     not just the one actually present on the wire, because protobufjs
 *     defines every declared field on the message's prototype regardless of
 *     whether it was set. That would silently break
 *     attributeValueToString()'s `"stringValue" in value` / `"intValue" in
 *     value` / ... chain (it would always take the first branch). `toObject()`
 *     with `defaults: false` only emits the field that was ACTUALLY decoded
 *     off the wire as an own key -- the same shape OTLP/JSON naturally has,
 *     since a JSON payload only ever contains the AnyValue variant that was
 *     actually set.
 *   - `arrays: true` -- without this, an EMPTY repeated field (e.g. a
 *     genuinely empty `resource_metrics: []` export -- a Collector's
 *     keep-alive/empty batch) is omitted from the object entirely rather
 *     than emitted as `[]`, which would make extractDatapoints()'s
 *     `Array.isArray(body.resourceMetrics)` guard reject a legitimately
 *     empty-but-well-formed batch with a 400 it would never give the
 *     equivalent OTLP/JSON body (`{"resourceMetrics": []}`).
 *
 * Field NAMING: protobufjs's default parser behavior (`keepCase: false`,
 * the default `protobuf.parse()`/`protobuf.loadSync()` use unless told
 * otherwise) camelCases every field name declared in the .proto file
 * (`resource_metrics` -> `resourceMetrics`, `data_points` -> `dataPoints`,
 * `as_double` -> `asDouble`, `string_value` -> `stringValue`, ...) -- the
 * EXACT same camelCase convention OTLP/JSON already uses. That is WHY this
 * function can hand its output straight to the unmodified
 * extractDatapoints()/flattenAttributes()/attributeValueToString() instead
 * of needing a parallel protobuf-specific parsing implementation.
 * @param {Buffer} buffer The raw request body bytes
 *     (`application/x-protobuf`, already read by the route's
 *     `express.raw()` middleware).
 * @returns {*} A plain object with the exact same shape
 *     extractDatapoints() accepts for OTLP/JSON bodies.
 * @throws {Error} If buffer is not a valid wire encoding of
 *     ExportMetricsServiceRequest (propagated from protobufjs's decode(),
 *     e.g. "invalid wire type" / "index out of range" / "illegal buffer").
 */
function decodeProtobufBody(buffer) {
    const message = ExportMetricsServiceRequestType.decode(buffer);
    return ExportMetricsServiceRequestType.toObject(message, {
        longs: Number,
        defaults: false,
        arrays: true,
    });
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

router.post(
    "/v1/metrics",
    // Route-specific body parsers ONLY (TASK-A2-4 hardening) -- each has its
    // own `type` matcher, so exactly one of the two ever actually reads the
    // body for a given request; see decodeProtobufBody()'s/server.js's
    // comments for why BOTH need an explicit limit here rather than relying
    // on the app-wide default. A Content-Length over MAX_TELEMETRY_PAYLOAD_BYTES
    // is rejected by body-parser itself (413) before this route's handler
    // function below ever runs.
    express.raw({
        type: (request) => isProtobufContentType(request.headers["content-type"]),
        limit: MAX_TELEMETRY_PAYLOAD_BYTES,
    }),
    express.json({ limit: MAX_TELEMETRY_PAYLOAD_BYTES }),
    async (request, response) => {
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

            // Per-team rate limit (TASK-A2-4 hardening) -- checked right after
            // auth (we need team.id to pick the right limiter) and before any
            // OTLP parsing/matching work, so a throttled team's requests don't
            // pay for that work. callback shape/calling convention mirrors
            // loginRateLimiter.pass(callback) call sites in server.js/auth.js.
            const rateLimitOk = await getTelemetryRateLimiterForTeam(team.id).pass((result) => {
                response.status(429).json(result);
            });
            if (!rateLimitOk) {
                return;
            }

            // Throws on a malformed/non-OTLP body -- caught below, mapped to 400.
            const datapoints = isProtobufContentType(request.headers["content-type"])
                ? extractDatapoints(decodeProtobufBody(request.body))
                : extractDatapoints(request.body);

            const otelMonitors = await R.find("monitor", " team_id = ? AND type = 'otel' AND active = 1 ", [team.id]);
            // matchDatapointsToMonitors() only needs id/otel_*/aggregation off each
            // monitor and returns {monitorId, aggregatedValue, matchedCount} --
            // keep the already-loaded full beans around by id so each match can be
            // processed as a heartbeat without a redundant per-monitor reload.
            const monitorById = new Map(otelMonitors.map((monitor) => [monitor.id, monitor]));

            // Cardinality cap (TASK-A2-4 hardening) -- see
            // server/otel-selector.js's matchDatapointsToMonitors() docstring:
            // a monitor whose selector matched more than
            // MAX_MATCHED_DATAPOINTS_PER_MONITOR datapoints in this one batch
            // gets its aggregation truncated to the first N (in payload
            // order), not rejected -- the batch as a whole still succeeds.
            const matches = matchDatapointsToMonitors(otelMonitors, datapoints, MAX_MATCHED_DATAPOINTS_PER_MONITOR);

            for (const match of matches) {
                const monitor = monitorById.get(match.monitorId);
                if (!monitor) {
                    continue;
                }

                if (match.truncated) {
                    log.warn(
                        "telemetry",
                        `[${monitor.name}] matched ${match.totalMatchedCount} datapoints in this batch, ` +
                            `truncated to ${match.matchedCount} (cap ${MAX_MATCHED_DATAPOINTS_PER_MONITOR}) before aggregation`
                    );
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
    }
);

module.exports = router;
