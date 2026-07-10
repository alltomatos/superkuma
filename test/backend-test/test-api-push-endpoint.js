process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server", "error_prometheus"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { SuperKumaServer } = require("../../server/superkuma-server");
const { Notification } = require("../../server/notification");
const { UP, DOWN, MAINTENANCE } = require("../../src/util");

// sendNotification() builds heartbeatJSON.localDateTime via dayjs.utc(...).tz(...) --
// these plugins are normally registered by server.js's own bootstrap, which this
// standalone test file never requires. Same convention as
// test-monitor-send-notification.js / test-uptime-calculator.js.
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

/**
 * Characterization baseline for router.all("/api/push/:pushToken", ...)
 * (server/routers/api-router.js:47), pinning the CURRENT contract before
 * ADR-0015 MVP-0 extends this exact endpoint with an optional numeric "value"
 * query param. There is no supertest dependency in this repo and no prior
 * precedent for exercising an Express route handler directly -- this file
 * instead reaches into the real express.Router() instance exported by
 * api-router.js and pulls out the actual registered handler function, then
 * drives it with hand-built mock req/res objects. See extractPushHandler().
 */

/**
 * Locate and return the real handler function Express registered for
 * router.all("/api/push/:pushToken", ...) inside the express.Router()
 * instance exported by server/routers/api-router.js.
 *
 * router.all(path, handler) makes Express's Route#all() push a SINGLE layer
 * onto route.stack (method left undefined, route.methods._all = true) --
 * unlike router.get/post/etc, which push one layer per HTTP verb. So the
 * layer whose route.path matches carries the one and only real handler at
 * route.stack[0].handle. Confirmed empirically: invoking the returned
 * function below produces the exact same 404 body/message and status-code
 * transitions the production source at api-router.js:47-149 defines, so this
 * is the real code path, not a re-implementation.
 * @returns {Function} The real async (request, response) => {...} route handler.
 * @throws {Error} If the route can't be located in api-router.js's stack (would mean the route path/registration changed).
 */
function extractPushHandler() {
    const router = require("../../server/routers/api-router.js");
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === "/api/push/:pushToken") {
            return layer.route.stack[0].handle;
        }
    }
    throw new Error("Could not locate router.all(\"/api/push/:pushToken\", ...) in api-router.js's route stack");
}

/**
 * Build a minimal mock Express request carrying only what the push handler
 * reads: request.params.pushToken and request.query.*.
 * @param {string} pushToken Value for request.params.pushToken
 * @param {object} query Value for request.query (defaults to {} when omitted)
 * @returns {object} Mock request
 */
function makeReq(pushToken, query) {
    return { params: { pushToken }, query: query || {} };
}

/**
 * Build a minimal mock Express response capturing status()/json() calls --
 * the only response methods the push handler ever calls (see api-router.js:140-148).
 * @returns {{statusCode: number, body: (object|undefined), status: Function, json: Function}} Mock response
 */
function makeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
}

/**
 * Creates and stores a Monitor bean with the given field overrides. Mirrors
 * the createMonitor() idiom in test-monitor-send-notification.js/test-monitor-model.js.
 * @param {object} fields Monitor fields to assign (camelCase, matching bean property names)
 * @returns {Promise<Monitor>} The stored monitor bean, reloaded from the DB
 */
async function createMonitor(fields) {
    let bean = R.dispense("monitor");
    bean.import({
        name: "push endpoint test monitor",
        type: "push",
        interval: 20,
        maxretries: 0,
        accepted_statuscodes_json: JSON.stringify(["200-299"]),
        conditions: "[]",
        kafkaProducerBrokers: "[]",
        kafkaProducerSaslOptions: "{}",
        rabbitmqNodes: "[]",
        ...fields,
    });
    await R.store(bean);
    // Reload so column defaults SQLite applies at insert time (e.g. active/resend_interval)
    // are reflected, matching how production code always operates on freshly-loaded beans.
    return await R.load("monitor", bean.id);
}

/**
 * Fetch the most recently stored heartbeat row for a monitor.
 * @param {number} monitorId Monitor id
 * @returns {Promise<object|null>} The latest heartbeat bean, or null if none exist
 */
async function latestHeartbeat(monitorId) {
    return await R.findOne("heartbeat", " monitor_id = ? ORDER BY id DESC", [monitorId]);
}

/**
 * Count heartbeat rows stored for a monitor.
 * @param {number} monitorId Monitor id
 * @returns {Promise<number>} Row count
 */
async function countHeartbeats(monitorId) {
    return await R.count("heartbeat", " monitor_id = ? ", [monitorId]);
}

/**
 * Place a monitor under "manual"-strategy maintenance (always-on, no
 * time-window arithmetic -- Maintenance#getStatus() short-circuits to
 * "under-maintenance" for strategy "manual" as long as active=true). Mirrors
 * how Monitor.isUnderMaintenance()/SuperKumaServer#getMaintenance() actually
 * resolve maintenance state in production: a monitor_maintenance join row
 * PLUS a bean registered on the live SuperKumaServer singleton's in-memory
 * maintenanceList (normally populated by loadMaintenanceList() at server
 * boot, which this standalone test file never calls).
 * @param {number} monitorId Monitor id to place under maintenance
 * @returns {Promise<void>}
 */
async function putUnderMaintenance(monitorId) {
    const bean = R.dispense("maintenance");
    bean.title = "characterization maintenance window";
    bean.description = "always-on manual maintenance for push endpoint tests";
    bean.active = true;
    bean.strategy = "manual";
    await R.store(bean);
    await R.knex("monitor_maintenance").insert({ monitor_id: monitorId, maintenance_id: bean.id });
    SuperKumaServer.getInstance().maintenanceList[bean.id] = bean;
}

let testUserId;

/**
 * Lazily create (once, memoized) a minimal user row to satisfy
 * notification.user_id's NOT NULL constraint. Molded on getTestUserId() in
 * test-monitor-send-notification.js -- a fixed username is enough since the
 * insert only ever happens once per test run, no randomness needed.
 * @returns {Promise<number>} The test user's id
 */
async function createTestUserId() {
    if (testUserId === undefined) {
        await R.knex("user").insert({ username: "push-baseline-owner", password: "x" });
        testUserId = (await R.knex("user").where("username", "push-baseline-owner").first()).id;
    }
    return testUserId;
}

/**
 * Dispense + store a notification bean using the "test-fake" provider type
 * this file registers onto Notification.providerList (before()/after()) --
 * never a real network-calling provider. Molded on createNotification() in
 * test-monitor-send-notification.js.
 * @param {object} fields Notification fields to override (name required)
 * @returns {Promise<number>} The stored notification's id
 */
async function createNotification(fields) {
    const bean = R.dispense("notification");
    bean.name = fields.name;
    bean.config = JSON.stringify({ name: fields.name, type: "test-fake" });
    bean.user_id = fields.userId;
    bean.active = true;
    bean.is_default = false;
    return await R.store(bean);
}

/**
 * Link a notification to a monitor via the monitor_notification join table.
 * @param {number} monitorId Monitor id
 * @param {number} notificationId Notification id
 * @returns {Promise<void>}
 */
async function linkNotification(monitorId, notificationId) {
    await R.knex("monitor_notification").insert({ monitor_id: monitorId, notification_id: notificationId });
}

describe("API push endpoint (/api/push/:pushToken) - characterization (pre ADR-0015 MVP-0)", () => {
    const testDb = new TestDB("./data/test-api-push-endpoint");
    let handler;
    /** @type {Array<{msg: string}>} */
    let sentCalls;
    let originalProviderList;

    before(async () => {
        await testDb.create();
        handler = extractPushHandler();

        originalProviderList = Notification.providerList;
        Notification.providerList = {
            "test-fake": {
                send: async (notification, msg) => {
                    sentCalls.push({ msg });
                    return "ok";
                },
            },
        };
    });

    after(async () => {
        Notification.providerList = originalProviderList;
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("sanity check: extractPushHandler() returns the real, live handler function", () => {
        assert.strictEqual(typeof handler, "function");
    });

    describe("unknown/inactive pushToken", () => {
        test("unrecognized pushToken -> 404 {ok:false, msg}", async () => {
            const res = makeRes();
            await handler(makeReq("this-token-was-never-issued"), res);

            assert.strictEqual(res.statusCode, 404);
            assert.deepStrictEqual(res.body, { ok: false, msg: "Monitor not found or not active." });
        });

        test("pushToken belonging to an INACTIVE monitor -> 404, same as unknown (active = 1 is part of the lookup)", async () => {
            const monitor = await createMonitor({
                name: "inactive push monitor",
                push_token: "inactive-monitor-token",
                active: false,
            });

            const res = makeRes();
            await handler(makeReq("inactive-monitor-token"), res);

            assert.strictEqual(res.statusCode, 404);
            assert.deepStrictEqual(res.body, { ok: false, msg: "Monitor not found or not active." });
            assert.strictEqual(await countHeartbeats(monitor.id), 0);
        });
    });

    describe("ping value validation", () => {
        test("negative ping -> 404 with the exact validation message, no heartbeat stored", async () => {
            const monitor = await createMonitor({ name: "ping-negative", push_token: "ping-negative-token" });

            const res = makeRes();
            await handler(makeReq("ping-negative-token", { ping: "-1" }), res);

            assert.strictEqual(res.statusCode, 404);
            assert.deepStrictEqual(res.body, {
                ok: false,
                msg: "Invalid ping value. Must be between 0 and 100000000000 ms.",
            });
            assert.strictEqual(await countHeartbeats(monitor.id), 0);
        });

        test("ping > 100000000000 (MAX_PING_MS) -> 404 with the exact validation message", async () => {
            const monitor = await createMonitor({ name: "ping-over-max", push_token: "ping-over-max-token" });

            const res = makeRes();
            await handler(makeReq("ping-over-max-token", { ping: "100000000001" }), res);

            assert.strictEqual(res.statusCode, 404);
            assert.deepStrictEqual(res.body, {
                ok: false,
                msg: "Invalid ping value. Must be between 0 and 100000000000 ms.",
            });
            assert.strictEqual(await countHeartbeats(monitor.id), 0);
        });

        test("ping = 100000000000 exactly (the MAX_PING_MS boundary) -> accepted and stored as-is", async () => {
            const monitor = await createMonitor({ name: "ping-boundary-max", push_token: "ping-boundary-max-token" });

            const res = makeRes();
            await handler(makeReq("ping-boundary-max-token", { ping: "100000000000" }), res);

            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, { ok: true });
            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.ping, 100000000000);
        });

        test("a normal, positive ping value is accepted and stored verbatim", async () => {
            const monitor = await createMonitor({ name: "ping-normal", push_token: "ping-normal-token" });

            const res = makeRes();
            await handler(makeReq("ping-normal-token", { ping: "42" }), res);

            assert.strictEqual(res.statusCode, 200);
            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.ping, 42);
        });

        test("ping = 0 CURRENTLY collapses to null -- `parseFloat(...) || null` treats 0 as falsy, so it never reaches (and never fails) the >=0 validation, and is stored as null rather than 0", async () => {
            const monitor = await createMonitor({ name: "ping-zero", push_token: "ping-zero-token" });

            const res = makeRes();
            await handler(makeReq("ping-zero-token", { ping: "0" }), res);

            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, { ok: true });
            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.ping, null);
        });

        test("ping omitted entirely -> stored as null, no validation error", async () => {
            const monitor = await createMonitor({ name: "ping-omitted", push_token: "ping-omitted-token" });

            const res = makeRes();
            await handler(makeReq("ping-omitted-token"), res);

            assert.strictEqual(res.statusCode, 200);
            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.ping, null);
        });
    });

    describe("status query param mapping", () => {
        test('status=up -> UP status on a first beat (maxretries=0 so determineStatus passes the mapped status straight through)', async () => {
            const monitor = await createMonitor({ name: "status-up", push_token: "status-up-token" });

            const res = makeRes();
            await handler(makeReq("status-up-token", { status: "up" }), res);

            assert.strictEqual(res.statusCode, 200);
            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.status, UP);
        });

        test("status=down -> DOWN status", async () => {
            const monitor = await createMonitor({ name: "status-down", push_token: "status-down-token" });

            const res = makeRes();
            await handler(makeReq("status-down-token", { status: "down" }), res);

            assert.strictEqual(res.statusCode, 200);
            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.status, DOWN);
        });

        test("any status string other than the literal 'up' (e.g. a typo) -> DOWN, not UP or an error -- current mapping is `status === \"up\" ? UP : DOWN`, not an allow-list", async () => {
            const monitor = await createMonitor({ name: "status-typo", push_token: "status-typo-token" });

            const res = makeRes();
            await handler(makeReq("status-typo-token", { status: "Up" }), res);

            assert.strictEqual(res.statusCode, 200);
            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.status, DOWN);
        });

        test("status omitted -> defaults to \"up\" -> UP status", async () => {
            const monitor = await createMonitor({ name: "status-omitted", push_token: "status-omitted-token" });

            const res = makeRes();
            await handler(makeReq("status-omitted-token"), res);

            assert.strictEqual(res.statusCode, 200);
            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.status, UP);
        });
    });

    describe("first-beat behavior (isFirstBeat=true, no previousHeartbeat)", () => {
        test("first beat has no previous heartbeat to diff against: downCount starts at 0 and important=true unconditionally", async () => {
            const monitor = await createMonitor({ name: "first-beat", push_token: "first-beat-token" });

            const res = makeRes();
            await handler(makeReq("first-beat-token", { status: "down" }), res);

            assert.strictEqual(res.statusCode, 200);
            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(Boolean(hb.important), true);
            assert.strictEqual(hb.downCount, 0);
            assert.strictEqual(await countHeartbeats(monitor.id), 1);
        });

        test("a SECOND beat is no longer the first beat: previousHeartbeat is used for duration/status-transition logic", async () => {
            const monitor = await createMonitor({ name: "second-beat", push_token: "second-beat-token" });

            await handler(makeReq("second-beat-token", { status: "up" }), makeRes());
            const first = await latestHeartbeat(monitor.id);

            await handler(makeReq("second-beat-token", { status: "up" }), makeRes());
            const second = await latestHeartbeat(monitor.id);

            assert.notStrictEqual(second.id, first.id);
            // UP -> UP is not an important transition (see Monitor.isImportantBeat).
            assert.strictEqual(Boolean(second.important), false);
        });
    });

    describe("maintenance-mode override", () => {
        test("monitor under maintenance -> bean.status is forced to MAINTENANCE regardless of the status query param", async () => {
            const monitor = await createMonitor({ name: "maint-status", push_token: "maint-status-token" });
            await putUnderMaintenance(monitor.id);

            const res = makeRes();
            await handler(makeReq("maint-status-token", { status: "up" }), res);

            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, { ok: true });
            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.status, MAINTENANCE);
        });

        test("maintenance overrides a DOWN report too -- status still forced to MAINTENANCE, not DOWN", async () => {
            const monitor = await createMonitor({ name: "maint-status-down", push_token: "maint-status-down-token" });
            await putUnderMaintenance(monitor.id);

            const res = makeRes();
            await handler(makeReq("maint-status-down-token", { status: "down" }), res);

            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.status, MAINTENANCE);
        });

        test("CURRENT bug/quirk: the stored heartbeat's msg is NOT actually overwritten under maintenance -- the handler reassigns the local `msg` variable to \"Monitor under maintenance\" AFTER bean.msg was already set from that same variable, so bean.msg keeps the original query msg (or the \"OK\" default)", async () => {
            const monitor = await createMonitor({ name: "maint-msg", push_token: "maint-msg-token" });
            await putUnderMaintenance(monitor.id);

            const res = makeRes();
            await handler(makeReq("maint-msg-token", { status: "up", msg: "custom caller message" }), res);

            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.status, MAINTENANCE);
            // NOT "Monitor under maintenance", despite that string existing in the handler source.
            assert.strictEqual(hb.msg, "custom caller message");
        });

        test("same quirk with the default msg: maintenance beat with no msg query param stores \"OK\", not \"Monitor under maintenance\"", async () => {
            const monitor = await createMonitor({ name: "maint-msg-default", push_token: "maint-msg-default-token" });
            await putUnderMaintenance(monitor.id);

            await handler(makeReq("maint-msg-default-token", { status: "up" }), makeRes());

            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.status, MAINTENANCE);
            assert.strictEqual(hb.msg, "OK");
        });
    });

    describe("msg query param", () => {
        test("msg omitted -> defaults to \"OK\"", async () => {
            const monitor = await createMonitor({ name: "msg-default", push_token: "msg-default-token" });

            await handler(makeReq("msg-default-token"), makeRes());

            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.msg, "OK");
        });

        test("msg provided -> stored verbatim", async () => {
            const monitor = await createMonitor({ name: "msg-custom", push_token: "msg-custom-token" });

            await handler(makeReq("msg-custom-token", { msg: "custom status text" }), makeRes());

            const hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.msg, "custom status text");
        });
    });

    describe("resendInterval down-count-and-resend logic for repeated DOWN beats", () => {
        test("with resendInterval=2: beat1 (first, DOWN) notifies + downCount resets to 0; beat2 (still DOWN) does NOT notify, downCount climbs to 1; beat3 (still DOWN) hits the threshold, notifies again, downCount resets to 0; beat4 repeats the cycle", async () => {
            const userId = await createTestUserId();
            const notifId = await createNotification({ name: "resend-notif", userId });
            const monitor = await createMonitor({
                name: "resend-monitor",
                push_token: "resend-token",
                resendInterval: 2,
            });
            await linkNotification(monitor.id, notifId);

            sentCalls = [];

            // Beat 1: first beat, DOWN -> isImportantForNotification is true unconditionally
            // on isFirstBeat, so this notifies and resets downCount to 0.
            const res1 = makeRes();
            await handler(makeReq("resend-token", { status: "down" }), res1);
            assert.strictEqual(res1.statusCode, 200);
            let hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.downCount, 0);
            assert.strictEqual(sentCalls.length, 1);

            // Beat 2: DOWN -> DOWN is not an important transition, so we fall into the
            // resend branch: downCount increments to 1, still below resendInterval (2).
            const res2 = makeRes();
            await handler(makeReq("resend-token", { status: "down" }), res2);
            hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.downCount, 1);
            assert.strictEqual(sentCalls.length, 1, "no additional notification below the resend threshold");

            // Beat 3: downCount would reach 2 (== resendInterval) -> resend fires,
            // downCount resets back to 0.
            const res3 = makeRes();
            await handler(makeReq("resend-token", { status: "down" }), res3);
            hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.downCount, 0);
            assert.strictEqual(sentCalls.length, 2, "resend notification fires once downCount hits resendInterval");

            // Beat 4: cycle repeats -- downCount climbs to 1 again, no notification yet.
            const res4 = makeRes();
            await handler(makeReq("resend-token", { status: "down" }), res4);
            hb = await latestHeartbeat(monitor.id);
            assert.strictEqual(hb.downCount, 1);
            assert.strictEqual(sentCalls.length, 2);
        });

        test("resendInterval=0 (disabled) -> repeated DOWN beats never resend, downCount stays 0 forever", async () => {
            const monitor = await createMonitor({
                name: "resend-disabled",
                push_token: "resend-disabled-token",
                resendInterval: 0,
            });

            sentCalls = [];
            await handler(makeReq("resend-disabled-token", { status: "down" }), makeRes());
            await handler(makeReq("resend-disabled-token", { status: "down" }), makeRes());
            const hb = await handler(makeReq("resend-disabled-token", { status: "down" }), makeRes()).then(() =>
                latestHeartbeat(monitor.id)
            );

            assert.strictEqual(hb.downCount, 0);
            // Only the first (isFirstBeat) beat notifies; no linked notification here
            // either way, but the assertion that matters is downCount never climbing.
            assert.strictEqual(sentCalls.length, 0);
        });
    });

    describe("successful response shape", () => {
        test("a successful push responds with exactly {ok: true} and HTTP 200, no extra fields", async () => {
            const monitor = await createMonitor({ name: "response-shape", push_token: "response-shape-token" });

            const res = makeRes();
            await handler(makeReq("response-shape-token"), res);

            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, { ok: true });
            assert.deepStrictEqual(Object.keys(res.body), ["ok"]);
            assert.strictEqual(await countHeartbeats(monitor.id), 1);
        });
    });
});
