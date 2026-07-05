/**
 * Monitor payload template and builder.
 *
 * The server's `add` / `editMonitor` handlers expect a *complete* monitor object
 * (the dashboard always sends every field). To keep the MCP tools small and safe
 * we start from a base object of sane defaults -- mirroring the frontend's
 * `monitorDefaults` in src/pages/EditMonitor.vue -- and overlay only the fields
 * the agent supplied. The server's `Monitor.validate()` remains the authoritative
 * gate; this template just guarantees a well-formed payload.
 */

/**
 * Default monitor payload, mirroring the dashboard's `monitorDefaults`. The
 * frontend-only `humanReadableInterval` field is intentionally omitted (the
 * server strips it anyway).
 * @type {object}
 */
const MONITOR_DEFAULTS = {
    type: "http",
    name: "",
    parent: null,
    url: "https://",
    wsSubprotocol: "",
    method: "GET",
    protocol: null,
    location: "world",
    ipFamily: null,
    interval: 60,
    retryInterval: 60,
    resendInterval: 0,
    maxretries: 0,
    retryOnlyOnStatusCodeFailure: false,
    notificationIDList: {},
    ignoreTls: false,
    upsideDown: false,
    expiryNotification: false,
    domainExpiryNotification: true,
    maxredirects: 10,
    accepted_statuscodes: ["200-299"],
    saveResponse: false,
    saveErrorResponse: true,
    responseMaxLength: 1024,
    dns_resolve_type: "A",
    dns_resolve_server: "",
    docker_container: "",
    docker_host: null,
    proxyId: null,
    basic_auth_user: "",
    basic_auth_pass: "",
    bearer_token: "",
    mqttUsername: "",
    mqttPassword: "",
    mqttTopic: "",
    mqttWebsocketPath: "",
    mqttSuccessMessage: "",
    mqttCheckType: "keyword",
    authMethod: null,
    oauth_auth_method: "client_secret_basic",
    httpBodyEncoding: "json",
    kafkaProducerBrokers: [],
    kafkaProducerSaslOptions: {
        mechanism: "None",
    },
    cacheBust: false,
    kafkaProducerSsl: false,
    kafkaProducerAllowAutoTopicCreation: false,
    gamedigGivenPortOnly: true,
    gamedigToken: "",
    remote_browser: null,
    screenshot_delay: 0,
    rabbitmqNodes: [],
    rabbitmqUsername: "",
    rabbitmqPassword: "",
    conditions: [],
    system_service_name: "",
};

/**
 * Agent-facing input keys that map 1:1 onto monitor payload keys.
 * @type {Array<string>}
 */
const DIRECT_FIELDS = [
    "type",
    "name",
    "url",
    "hostname",
    "method",
    "body",
    "keyword",
    "invertKeyword",
    "upsideDown",
    "description",
    "interval",
    "retryInterval",
    "resendInterval",
    "maxretries",
    "maxredirects",
    "ignoreTls",
    "expiryNotification",
    "dns_resolve_type",
    "dns_resolve_server",
    "active",
];

/**
 * Build a complete monitor payload by overlaying agent-supplied fields onto a
 * base object. For `create_monitor` the base is {@link MONITOR_DEFAULTS}; for
 * `update_monitor` it is the monitor fetched from the server (so unspecified
 * fields keep their current values).
 * @param {object} base Base monitor object; cloned, never mutated.
 * @param {object} input Agent-supplied fields (see the tool input schemas).
 * @returns {object} A complete monitor payload ready for `add`/`editMonitor`.
 */
function buildMonitorPayload(base, input) {
    const monitor = { ...base };

    for (const key of DIRECT_FIELDS) {
        if (input[key] !== undefined) {
            monitor[key] = input[key];
        }
    }

    if (input.port !== undefined) {
        monitor.port = input.port;
    }

    if (input.parent !== undefined) {
        monitor.parent = input.parent;
    }

    if (input.acceptedStatusCodes !== undefined) {
        monitor.accepted_statuscodes = input.acceptedStatusCodes;
    }

    if (input.headers !== undefined) {
        monitor.headers = typeof input.headers === "string" ? input.headers : JSON.stringify(input.headers);
    }

    if (input.notificationIds !== undefined) {
        const map = {};
        for (const id of input.notificationIds) {
            map[id] = true;
        }
        monitor.notificationIDList = map;
    }

    return monitor;
}

/**
 * Reduce a full monitor object to a compact summary for list views.
 * @param {object} monitor A monitor object from the server.
 * @returns {object} A trimmed summary.
 */
function summarizeMonitor(monitor) {
    return {
        id: monitor.id,
        name: monitor.name,
        type: monitor.type,
        url: monitor.url ?? null,
        hostname: monitor.hostname ?? null,
        port: monitor.port ?? null,
        interval: monitor.interval,
        active: Boolean(monitor.active),
        parent: monitor.parent ?? null,
    };
}

module.exports = {
    MONITOR_DEFAULTS,
    buildMonitorPayload,
    summarizeMonitor,
};
