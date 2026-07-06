const { describe, test } = require("node:test");
const assert = require("node:assert");

const { parseBool, parseIntEnv, loadConfig, loadGates } = require("../../server/mcp/config");
const mcpRouter = require("../../server/routers/mcp-router");
const { MONITOR_DEFAULTS, buildMonitorPayload, summarizeMonitor } = require("../../server/mcp/monitor-template");
const {
    MAINTENANCE_DEFAULTS,
    buildMaintenancePayload,
    summarizeMaintenance,
} = require("../../server/mcp/maintenance-template");
const { registerAllTools } = require("../../server/mcp/tools");

/**
 * Minimal stand-in for McpServer that records registered tools and lets tests
 * invoke a tool's handler and read back its parsed JSON payload.
 */
class FakeServer {
    /** @returns {void} */
    constructor() {
        this.tools = {};
    }

    /**
     * Record a tool registration.
     * @param {string} name Tool name.
     * @param {object} def Tool definition.
     * @param {Function} handler Tool handler.
     * @returns {void}
     */
    registerTool(name, def, handler) {
        this.tools[name] = { def, handler };
    }

    /** @returns {Array<string>} Sorted registered tool names. */
    names() {
        return Object.keys(this.tools).sort();
    }

    /**
     * Invoke a registered tool and return its parsed result.
     * @param {string} name Tool name.
     * @param {object} args Tool args.
     * @returns {Promise<object>} { isError, data }.
     */
    async call(name, args) {
        const tool = this.tools[name];
        if (!tool) {
            throw new Error(`tool ${name} not registered`);
        }
        const res = await tool.handler(args || {}, {});
        const text = res.content && res.content[0] ? res.content[0].text : "";
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            data = text;
        }
        return { isError: Boolean(res.isError), data };
    }
}

/**
 * Minimal stand-in for SuperKumaClient: records request() calls and returns
 * canned responses, with the same cache fields the tools read.
 */
class FakeClient {
    /** @returns {void} */
    constructor() {
        this.calls = [];
        this.responses = {};
        this.monitors = {};
        this.notifications = [];
        this.maintenances = {};
        this.statusPages = {};
    }

    /**
     * Record and answer a request.
     * @param {string} event Event name.
     * @param {...any} args Positional args.
     * @returns {Promise<object>} The canned response ({ ok: true } by default).
     */
    request(event, ...args) {
        this.calls.push({ event, args });
        const r = this.responses[event];
        const value = typeof r === "function" ? r(...args) : r;
        return Promise.resolve(value === undefined ? { ok: true } : value);
    }

    /** @returns {Promise<Array<object>>} Cached monitors. */
    listMonitors() {
        return Promise.resolve(Object.values(this.monitors));
    }

    /** @returns {Promise<Array<object>>} Cached maintenances. */
    listMaintenances() {
        return Promise.resolve(Object.values(this.maintenances));
    }

    /** @returns {Promise<Array<object>>} Cached status pages. */
    listStatusPages() {
        return Promise.resolve(Object.values(this.statusPages));
    }
}

/**
 * Find the recorded call for an event.
 * @param {FakeClient} client The fake client.
 * @param {string} event Event name.
 * @returns {object|undefined} The recorded { event, args } or undefined.
 */
function lastCall(client, event) {
    return [...client.calls].reverse().find((c) => c.event === event);
}

describe("MCP config", () => {
    test("parseBool only treats true/1 as true", () => {
        assert.strictEqual(parseBool("true"), true);
        assert.strictEqual(parseBool("1"), true);
        assert.strictEqual(parseBool("TRUE"), true);
        assert.strictEqual(parseBool("false"), false);
        assert.strictEqual(parseBool("yes"), false);
        assert.strictEqual(parseBool(undefined), false);
    });

    test("parseIntEnv falls back for invalid/non-positive values", () => {
        assert.strictEqual(parseIntEnv("5000", 10000), 5000);
        assert.strictEqual(parseIntEnv("abc", 10000), 10000);
        assert.strictEqual(parseIntEnv("0", 10000), 10000);
        assert.strictEqual(parseIntEnv(undefined, 10000), 10000);
    });

    test("loadConfig throws without an API key", () => {
        const saved = process.env.SUPERKUMA_API_KEY;
        delete process.env.SUPERKUMA_API_KEY;
        assert.throws(() => loadConfig(), /SUPERKUMA_API_KEY is required/);
        if (saved !== undefined) {
            process.env.SUPERKUMA_API_KEY = saved;
        }
    });

    test("loadConfig applies defaults and gates", () => {
        const saved = { ...process.env };
        process.env.SUPERKUMA_API_KEY = "uk1_secret";
        delete process.env.SUPERKUMA_URL;
        delete process.env.SUPERKUMA_ALLOW_MUTATIONS;
        delete process.env.SUPERKUMA_ALLOW_DELETE;
        const cfg = loadConfig();
        assert.strictEqual(cfg.url, "http://localhost:3001");
        assert.strictEqual(cfg.allowMutations, false);
        assert.strictEqual(cfg.allowDelete, false);
        assert.strictEqual(cfg.requestTimeout, 10000);
        process.env = saved;
    });
});

describe("MCP monitor payload", () => {
    test("create payload starts from defaults and overlays fields", () => {
        const payload = buildMonitorPayload(MONITOR_DEFAULTS, { type: "http", name: "My HTTP" });
        assert.strictEqual(payload.type, "http");
        assert.strictEqual(payload.name, "My HTTP");
        assert.deepStrictEqual(payload.accepted_statuscodes, ["200-299"]);
        assert.strictEqual(payload.interval, 60);
        assert.deepStrictEqual(payload.notificationIDList, {});
        // Must not mutate the shared defaults object.
        assert.strictEqual(MONITOR_DEFAULTS.name, "");
    });

    test("notificationIds array becomes an id->true map", () => {
        const payload = buildMonitorPayload(MONITOR_DEFAULTS, {
            type: "http",
            name: "N",
            notificationIds: [1, 4],
        });
        assert.deepStrictEqual(payload.notificationIDList, { 1: true, 4: true });
    });

    test("headers object is JSON-stringified; acceptedStatusCodes overrides", () => {
        const payload = buildMonitorPayload(MONITOR_DEFAULTS, {
            type: "http",
            name: "H",
            headers: { "X-Test": "1" },
            acceptedStatusCodes: ["200", "301"],
        });
        assert.strictEqual(payload.headers, '{"X-Test":"1"}');
        assert.deepStrictEqual(payload.accepted_statuscodes, ["200", "301"]);
    });

    test("summarizeMonitor returns a compact view", () => {
        const s = summarizeMonitor({ id: 3, name: "x", type: "port", hostname: "h", port: 80, interval: 60, active: 1 });
        assert.deepStrictEqual(s, {
            id: 3,
            name: "x",
            type: "port",
            url: null,
            hostname: "h",
            port: 80,
            interval: 60,
            active: true,
            parent: null,
        });
    });
});

describe("MCP maintenance payload", () => {
    test("defaults to the manual strategy with an empty date range", () => {
        const payload = buildMaintenancePayload(MAINTENANCE_DEFAULTS, { title: "Win" });
        assert.strictEqual(payload.title, "Win");
        assert.strictEqual(payload.strategy, "manual");
        assert.deepStrictEqual(payload.dateRange, [null, null]);
    });

    test("single strategy overlays the date range", () => {
        const payload = buildMaintenancePayload(MAINTENANCE_DEFAULTS, {
            title: "W",
            strategy: "single",
            startDateTime: "2026-01-01 00:00:00",
            endDateTime: "2026-01-01 02:00:00",
        });
        assert.strictEqual(payload.strategy, "single");
        assert.deepStrictEqual(payload.dateRange, ["2026-01-01 00:00:00", "2026-01-01 02:00:00"]);
    });

    test("recurring times parse HH:mm into {hours,minutes}", () => {
        const payload = buildMaintenancePayload(MAINTENANCE_DEFAULTS, {
            title: "R",
            strategy: "recurring-weekday",
            startTime: "02:30",
            endTime: "05:00",
            weekdays: [1, 3, 5],
        });
        assert.deepStrictEqual(payload.timeRange[0], { hours: 2, minutes: 30 });
        assert.deepStrictEqual(payload.timeRange[1], { hours: 5, minutes: 0 });
        assert.deepStrictEqual(payload.weekdays, [1, 3, 5]);
    });

    test("summarizeMaintenance returns a compact view", () => {
        const s = summarizeMaintenance({ id: 1, title: "t", strategy: "manual", active: 1, status: "under-maintenance" });
        assert.deepStrictEqual(s, { id: 1, title: "t", strategy: "manual", active: true, status: "under-maintenance" });
    });
});

describe("MCP tool gating", () => {
    test("read-only config registers only read tools", () => {
        const server = new FakeServer();
        registerAllTools(server, new FakeClient(), { allowMutations: false, allowDelete: false });
        const names = server.names();
        const mutating = names.filter((n) => /^(create|update|delete|pause|resume|add_monitor_tag|remove_monitor_tag|test_|post_|resolve_)/.test(n));
        assert.deepStrictEqual(mutating, [], "no mutating tools should be registered read-only");
        assert.ok(names.includes("list_monitors"));
        assert.ok(names.includes("get_info"));
    });

    test("mutations without delete hides only destructive tools", () => {
        const server = new FakeServer();
        registerAllTools(server, new FakeClient(), { allowMutations: true, allowDelete: false });
        const names = server.names();
        assert.ok(names.includes("create_monitor"));
        assert.ok(!names.includes("delete_monitor"));
        assert.ok(!names.includes("delete_notification"));
        assert.ok(!names.includes("delete_status_page"));
    });

    test("full config registers the complete tool set", () => {
        const server = new FakeServer();
        registerAllTools(server, new FakeClient(), { allowMutations: true, allowDelete: true });
        const names = server.names();
        for (const expected of [
            "create_monitor", "delete_monitor", "create_notification", "delete_notification",
            "create_tag", "add_monitor_tag", "create_status_page", "post_incident",
            "create_maintenance", "delete_maintenance",
        ]) {
            assert.ok(names.includes(expected), `missing ${expected}`);
        }
    });
});

describe("MCP tool behaviour", () => {
    const fullConfig = { allowMutations: true, allowDelete: true };

    test("create_monitor forwards a complete payload to 'add'", async () => {
        const server = new FakeServer();
        const client = new FakeClient();
        client.responses.add = { ok: true, monitorID: 7 };
        registerAllTools(server, client, fullConfig);

        const res = await server.call("create_monitor", { type: "http", name: "Web", url: "https://x.test" });
        assert.strictEqual(res.isError, false);
        assert.strictEqual(res.data.monitorID, 7);

        const call = lastCall(client, "add");
        assert.ok(call, "add was called");
        const payload = call.args[0];
        assert.strictEqual(payload.type, "http");
        assert.strictEqual(payload.url, "https://x.test");
        assert.deepStrictEqual(payload.accepted_statuscodes, ["200-299"]);
    });

    test("update_monitor fetches then merges into 'editMonitor'", async () => {
        const server = new FakeServer();
        const client = new FakeClient();
        client.responses.getMonitor = {
            ok: true,
            monitor: { id: 5, name: "Old", type: "http", interval: 60, accepted_statuscodes: ["200-299"] },
        };
        client.responses.editMonitor = { ok: true, monitorID: 5 };
        registerAllTools(server, client, fullConfig);

        const res = await server.call("update_monitor", { id: 5, interval: 120 });
        assert.strictEqual(res.isError, false);

        const call = lastCall(client, "editMonitor");
        assert.strictEqual(call.args[0].id, 5);
        assert.strictEqual(call.args[0].interval, 120);
        assert.strictEqual(call.args[0].name, "Old", "unspecified fields are preserved");
    });

    test("delete_monitor is a dry-run without confirm and a real call with it", async () => {
        const server = new FakeServer();
        const client = new FakeClient();
        client.monitors = { 9: { id: 9, name: "Gone", type: "http" } };
        registerAllTools(server, client, fullConfig);

        const dry = await server.call("delete_monitor", { id: 9, confirm: false });
        assert.strictEqual(dry.data.dryRun, true);
        assert.strictEqual(lastCall(client, "deleteMonitor"), undefined, "no delete on dry-run");

        const real = await server.call("delete_monitor", { id: 9, confirm: true });
        assert.strictEqual(real.data.ok, true);
        assert.ok(lastCall(client, "deleteMonitor"), "delete on confirm");
    });

    test("list_notifications summarises without leaking provider secrets", async () => {
        const server = new FakeServer();
        const client = new FakeClient();
        client.notifications = [
            {
                id: 1,
                name: "Hook",
                config: JSON.stringify({ name: "Hook", type: "webhook", webhookURL: "https://secret.example/abc" }),
                isDefault: 0,
                active: 1,
            },
        ];
        registerAllTools(server, client, fullConfig);

        const res = await server.call("list_notifications", {});
        assert.strictEqual(res.data.count, 1);
        assert.strictEqual(res.data.notifications[0].type, "webhook");
        assert.ok(!JSON.stringify(res.data).includes("secret.example"), "secret URL must not be exposed");
    });

    test("create_notification merges config into the notification object", async () => {
        const server = new FakeServer();
        const client = new FakeClient();
        client.responses.addNotification = { ok: true, id: 3 };
        registerAllTools(server, client, fullConfig);

        await server.call("create_notification", {
            name: "Tel",
            type: "telegram",
            config: { telegramBotToken: "T", telegramChatID: "C" },
        });
        const call = lastCall(client, "addNotification");
        const notification = call.args[0];
        assert.strictEqual(notification.name, "Tel");
        assert.strictEqual(notification.type, "telegram");
        assert.strictEqual(notification.telegramBotToken, "T");
        assert.strictEqual(call.args[1], null, "notificationID is null for create");
    });

    test("create_monitor maps prometheus fields onto the reused columns", async () => {
        const server = new FakeServer();
        const client = new FakeClient();
        client.responses.add = { ok: true, monitorID: 11 };
        registerAllTools(server, client, fullConfig);

        await server.call("create_monitor", {
            type: "prometheus",
            name: "node01 CPU",
            url: "http://prometheus:9090",
            promql: "100 - avg(rate(node_cpu_seconds_total[5m]))*100",
            conditionOperator: ">",
            expectedValue: "90",
            bearerToken: "tok",
        });

        const payload = lastCall(client, "add").args[0];
        assert.strictEqual(payload.type, "prometheus");
        assert.strictEqual(payload.url, "http://prometheus:9090");
        assert.strictEqual(payload.databaseQuery, "100 - avg(rate(node_cpu_seconds_total[5m]))*100");
        assert.strictEqual(payload.jsonPathOperator, ">");
        assert.strictEqual(payload.expectedValue, "90");
        assert.strictEqual(payload.bearer_token, "tok");
    });
});

describe("MCP config gates", () => {
    test("loadGates reads the mutation/delete gates without an API key", () => {
        const saved = { ...process.env };
        process.env.SUPERKUMA_ALLOW_MUTATIONS = "true";
        process.env.SUPERKUMA_ALLOW_DELETE = "1";
        delete process.env.SUPERKUMA_API_KEY;
        const gates = loadGates();
        assert.strictEqual(gates.allowMutations, true);
        assert.strictEqual(gates.allowDelete, true);
        assert.strictEqual(typeof gates.requestTimeout, "number");
        assert.ok(!("apiKey" in gates), "gates must not require/return an API key");
        process.env = saved;
    });
});

describe("MCP HTTP endpoint helpers", () => {
    test("getApiKey extracts the Bearer token (case-insensitive)", () => {
        assert.strictEqual(mcpRouter.getApiKey({ headers: { authorization: "Bearer uk1_abc" } }), "uk1_abc");
        assert.strictEqual(mcpRouter.getApiKey({ headers: { authorization: "bearer  uk2_x " } }), "uk2_x");
    });

    test("getApiKey returns null when the header is missing or malformed", () => {
        assert.strictEqual(mcpRouter.getApiKey({ headers: {} }), null);
        assert.strictEqual(mcpRouter.getApiKey({ headers: { authorization: "Basic abc" } }), null);
    });

    test("isEnabled only true for true/1", () => {
        const saved = process.env.SUPERKUMA_MCP_HTTP_ENABLED;
        process.env.SUPERKUMA_MCP_HTTP_ENABLED = "true";
        assert.strictEqual(mcpRouter.isEnabled(), true);
        process.env.SUPERKUMA_MCP_HTTP_ENABLED = "false";
        assert.strictEqual(mcpRouter.isEnabled(), false);
        delete process.env.SUPERKUMA_MCP_HTTP_ENABLED;
        assert.strictEqual(mcpRouter.isEnabled(), false);
        if (saved !== undefined) {
            process.env.SUPERKUMA_MCP_HTTP_ENABLED = saved;
        }
    });

    test("jsonRpcError builds a valid JSON-RPC envelope", () => {
        assert.deepStrictEqual(mcpRouter.jsonRpcError(-32001, "nope"), {
            jsonrpc: "2.0",
            error: { code: -32001, message: "nope" },
            id: null,
        });
    });
});
