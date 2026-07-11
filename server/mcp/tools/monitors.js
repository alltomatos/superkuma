const { z } = require("zod");
const { registerTool } = require("./helpers");
const { MONITOR_DEFAULTS, buildMonitorPayload, summarizeMonitor } = require("../monitor-template");

const TYPE_HELP =
    "Monitor type. Common values: http, port, ping, dns, keyword, json-query, push, docker, group, " +
    "grpc-keyword, steam, gamedig, mqtt, postgres, mysql, mongodb, redis, sqlserver, radius, snmp, " +
    "prometheus, influxdb, real-browser, kafka-producer, rabbitmq, tailscale-ping. The server validates the type.";

const CONDITION_OPERATORS = [">", ">=", "<", "<=", "==", "!=", "contains"];

/**
 * Zod raw shape shared by create/update, minus the identity/type fields which
 * differ between the two operations.
 * @type {object}
 */
const commonMonitorShape = {
    url: z
        .string()
        .optional()
        .describe("Target URL for http/keyword/json-query/real-browser types, e.g. https://example.com"),
    hostname: z.string().optional().describe("Target hostname or IP for port/ping/dns/steam/... types"),
    port: z.number().int().optional().describe("Target port for port/dns/steam/... types"),
    interval: z.number().int().min(20).optional().describe("Check interval in seconds (minimum 20). Default 60"),
    retryInterval: z.number().int().min(20).optional().describe("Retry interval in seconds while down. Default 60"),
    resendInterval: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Resend notification every N checks while down (0 = notify once). Default 0"),
    maxretries: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of retries before marking the monitor down. Default 0"),
    keyword: z.string().optional().describe("Keyword to search for in the response body (keyword type)"),
    invertKeyword: z.boolean().optional().describe("If true, the keyword being present means DOWN"),
    upsideDown: z.boolean().optional().describe("Invert the status: a reachable target is treated as DOWN"),
    method: z.string().optional().describe("HTTP method for http types. Default GET"),
    body: z.string().optional().describe("HTTP request body"),
    headers: z
        .union([z.string(), z.record(z.string(), z.any())])
        .optional()
        .describe("HTTP headers as a JSON object or a JSON string"),
    acceptedStatusCodes: z
        .array(z.string())
        .optional()
        .describe('Accepted HTTP status code ranges, e.g. ["200-299"]. Default ["200-299"]'),
    maxredirects: z.number().int().min(0).optional().describe("Maximum HTTP redirects to follow. Default 10"),
    ignoreTls: z.boolean().optional().describe("Ignore TLS/SSL certificate errors"),
    expiryNotification: z.boolean().optional().describe("Notify on TLS certificate expiry"),
    dns_resolve_type: z.string().optional().describe("DNS record type for dns monitors (A, AAAA, CNAME, MX, TXT, ...)"),
    dns_resolve_server: z.string().optional().describe("DNS server to query for dns monitors"),
    notificationIds: z.array(z.number().int()).optional().describe("IDs of notifications to attach to this monitor"),
    parent: z.number().int().nullable().optional().describe("Parent group monitor ID, or null for a top-level monitor"),
    description: z.string().optional().describe("Free-text description"),
    // prometheus type (also: url = Prometheus base URL, ignoreTls, bearerToken)
    promql: z
        .string()
        .optional()
        .describe("PromQL instant query returning a single number (prometheus type), e.g. 'node_load1'"),
    conditionOperator: z
        .enum(CONDITION_OPERATORS)
        .optional()
        .describe("Threshold operator for prometheus/influxdb/snmp/json-query (>, >=, <, <=, ==, !=, contains)"),
    expectedValue: z
        .string()
        .optional()
        .describe("Value the query result is compared against, for the conditionOperator"),
    metricUnit: z
        .string()
        .optional()
        .describe(
            "Display unit for a metric monitor (prometheus/influxdb/snmp/json-query), e.g. '%', 'GB', 'MB', 's'. Shown " +
                "next to the value, gauge and chart on the monitor page. '%' puts the gauge and chart on a fixed " +
                "0-100 scale; any other unit auto-scales. Does not change the query -- match it to what the query returns."
        ),
    bearerToken: z.string().optional().describe("Optional Bearer token for auth (http/prometheus types)"),
    basicAuthUser: z
        .string()
        .optional()
        .describe(
            "HTTP Basic auth username (http/prometheus/influxdb types). For influxdb, this is the " +
                "recommended way to authenticate against InfluxDB v1's HTTP API."
        ),
    basicAuthPass: z.string().optional().describe("HTTP Basic auth password, paired with basicAuthUser"),
    // influxdb type (also: url = InfluxDB base URL, ignoreTls). The threshold reuses
    // conditionOperator/expectedValue/metricUnit. Prefer basicAuthUser/basicAuthPass over bearerToken --
    // InfluxDB v1's "Token" auth scheme is actually `username:password`, not an opaque v2-style token.
    influxdbDatabase: z
        .string()
        .optional()
        .describe("InfluxDB v1 database name -- the `db` query param (influxdb type)"),
    influxql: z
        .string()
        .optional()
        .describe(
            'InfluxQL query returning a single number (influxdb type), e.g. \'SELECT last("load1") FROM "system"\''
        ),
};

/**
 * Register all monitor-related MCP tools (read tools always; create/update/
 * pause/resume when mutations are enabled; delete when deletes are enabled).
 * @param {object} server The McpServer instance.
 * @param {object} client The SuperKumaClient instance.
 * @param {object} config Resolved MCP configuration.
 * @returns {void}
 */
function registerMonitorTools(server, client, config) {
    registerTool(server, config, {
        name: "list_monitors",
        title: "List monitors",
        description:
            "List all monitors visible to the authenticated API key, as compact summaries (id, name, type, target, interval, active, teamId). Pass teamId to filter to a single team's monitors, e.g. to build a dashboard for that team.",
        inputSchema: {
            teamId: z.number().int().optional().describe("Only return monitors belonging to this team id"),
        },
        handler: async (args) => {
            let monitors = await client.listMonitors();
            if (args.teamId !== undefined) {
                monitors = monitors.filter((m) => m.teamId === args.teamId);
            }
            return {
                count: monitors.length,
                monitors: monitors.map(summarizeMonitor),
            };
        },
    });

    registerTool(server, config, {
        name: "get_monitor",
        title: "Get monitor",
        description: "Fetch the full configuration of a single monitor by id.",
        inputSchema: {
            id: z.number().int().describe("Monitor id"),
        },
        handler: async (args) => {
            const res = await client.request("getMonitor", args.id);
            return res.monitor;
        },
    });

    registerTool(server, config, {
        name: "get_monitor_beats",
        title: "Get monitor heartbeats",
        description: "Fetch recent heartbeats (status history) for a monitor over the last N hours.",
        inputSchema: {
            id: z.number().int().describe("Monitor id"),
            hours: z.number().int().min(1).default(24).describe("How many hours of history to fetch. Default 24"),
        },
        handler: async (args) => {
            const res = await client.request("getMonitorBeats", args.id, args.hours);
            return {
                monitorID: args.id,
                hours: args.hours,
                beats: res.data,
            };
        },
    });

    registerTool(server, config, {
        name: "create_monitor",
        title: "Create monitor",
        description:
            "Create a new monitor. Only 'type' and 'name' are required; every other field falls back to a sensible default. The server validates the final payload.",
        mutation: true,
        inputSchema: {
            type: z.string().describe(TYPE_HELP),
            name: z.string().min(1).describe("Human-readable monitor name"),
            active: z.boolean().optional().describe("Start monitoring immediately. Default true"),
            ...commonMonitorShape,
        },
        handler: async (args) => {
            const payload = buildMonitorPayload(MONITOR_DEFAULTS, args);
            const res = await client.request("add", payload);
            return {
                ok: true,
                monitorID: res.monitorID,
                message: `Created monitor "${args.name}" (id ${res.monitorID}).`,
            };
        },
    });

    registerTool(server, config, {
        name: "update_monitor",
        title: "Update monitor",
        description:
            "Update an existing monitor. Fetches the current config and overlays only the fields you provide, so unspecified fields keep their values. To pause/resume use pause_monitor/resume_monitor instead.",
        mutation: true,
        inputSchema: {
            id: z.number().int().describe("Id of the monitor to update"),
            type: z.string().optional().describe(TYPE_HELP),
            name: z.string().min(1).optional().describe("Human-readable monitor name"),
            ...commonMonitorShape,
        },
        handler: async (args) => {
            const current = await client.request("getMonitor", args.id);
            if (!current || !current.monitor) {
                throw new Error(`Monitor ${args.id} not found.`);
            }
            const payload = buildMonitorPayload(current.monitor, args);
            payload.id = args.id;
            const res = await client.request("editMonitor", payload);
            return {
                ok: true,
                monitorID: res.monitorID,
                message: `Updated monitor id ${args.id}.`,
            };
        },
    });

    registerTool(server, config, {
        name: "pause_monitor",
        title: "Pause monitor",
        description: "Pause (stop checking) a monitor.",
        mutation: true,
        inputSchema: {
            id: z.number().int().describe("Monitor id"),
        },
        handler: async (args) => {
            await client.request("pauseMonitor", args.id);
            return { ok: true, message: `Paused monitor id ${args.id}.` };
        },
    });

    registerTool(server, config, {
        name: "resume_monitor",
        title: "Resume monitor",
        description: "Resume (start checking) a paused monitor.",
        mutation: true,
        inputSchema: {
            id: z.number().int().describe("Monitor id"),
        },
        handler: async (args) => {
            await client.request("resumeMonitor", args.id);
            return { ok: true, message: `Resumed monitor id ${args.id}.` };
        },
    });

    registerTool(server, config, {
        name: "delete_monitor",
        title: "Delete monitor",
        description:
            "Permanently delete a monitor. Destructive: requires the delete gate to be enabled and confirm=true. For group monitors, deleteChildren controls whether child monitors are deleted (true) or just unlinked (false).",
        mutation: true,
        destructive: true,
        inputSchema: {
            id: z.number().int().describe("Monitor id"),
            confirm: z.boolean().describe("Must be true to actually delete. If false, returns a dry-run description."),
            deleteChildren: z
                .boolean()
                .default(false)
                .describe("For group monitors: delete child monitors too (true) or unlink them (false). Default false"),
        },
        handler: async (args) => {
            if (!args.confirm) {
                const monitor = client.monitors[args.id];
                return {
                    ok: false,
                    dryRun: true,
                    message:
                        `Would delete monitor id ${args.id}${monitor ? ` ("${monitor.name}", type ${monitor.type})` : ""}. ` +
                        "Re-run with confirm=true to proceed.",
                };
            }
            await client.request("deleteMonitor", args.id, args.deleteChildren);
            return { ok: true, message: `Deleted monitor id ${args.id}.` };
        },
    });
}

module.exports = { registerMonitorTools };
