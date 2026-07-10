process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const Monitor = require("../../server/model/monitor");
const { Notification } = require("../../server/notification");
const { Settings } = require("../../server/settings");
const { UP, DOWN, PENDING, SQL_DATETIME_FORMAT } = require("../../src/util");

// sendNotification() builds heartbeatJSON.localDateTime via dayjs.utc(...).tz(...) --
// these plugins are normally registered by server.js's own bootstrap, which this
// standalone test file never requires. Same convention as test-uptime-calculator.js.
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

/**
 * Characterization baseline for Monitor.sendNotification/getNotificationList
 * (server/model/monitor.js), pinning current behavior BEFORE ADR-0014
 * (alert severity + notification routing) touches this code path. Molded on
 * the createMonitor() idiom in test-monitor-model.js.
 * @param {object} fields Monitor fields to assign (camelCase, matching bean property names)
 * @returns {Promise<Monitor>} The stored monitor bean, reloaded from the DB
 */
async function createMonitor(fields) {
    let bean = R.dispense("monitor");
    bean.import({
        name: "notification test monitor",
        type: "http",
        url: "https://example.com",
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
    return await R.load("monitor", bean.id);
}

/**
 * Dispense + store a notification bean, molded on the fixture idiom in
 * test-server-notification-authz.js. Uses the "test-fake"/"test-fake-throws"
 * provider types registered onto Notification.providerList by this file's
 * before()/beforeEach() -- never a real network-calling provider.
 * @param {object} fields Notification fields to override (name/type required)
 * @returns {Promise<number>} The stored notification's id
 */
async function createNotification(fields) {
    const bean = R.dispense("notification");
    bean.name = fields.name;
    bean.config = JSON.stringify({ name: fields.name, type: fields.type });
    bean.user_id = fields.user_id ?? (await getTestUserId());
    bean.active = fields.active ?? true;
    bean.is_default = false;
    return await R.store(bean);
}

let testUserId;

/**
 * Lazily create (once per test file run) a minimal user row to satisfy
 * notification.user_id's NOT NULL constraint -- these tests don't exercise
 * any actor/RBAC path, just the plain FK requirement.
 * @returns {Promise<number>} The test user's id
 */
async function getTestUserId() {
    if (testUserId === undefined) {
        await R.knex("user").insert({ username: "notif-baseline-owner", password: "x" });
        testUserId = (await R.knex("user").where("username", "notif-baseline-owner").first()).id;
    }
    return testUserId;
}

/**
 * Link a notification to a monitor via the monitor_notification join table,
 * mirroring the exact columns Monitor.getNotificationList() joins against.
 * @param {number} monitorId The monitor's id
 * @param {number} notificationId The notification's id
 * @returns {Promise<void>}
 */
async function linkNotification(monitorId, notificationId) {
    await R.knex("monitor_notification").insert({ monitor_id: monitorId, notification_id: notificationId });
}

/**
 * Build an in-memory (not stored) heartbeat bean matching the shape
 * Monitor.beat() constructs, for passing directly into sendNotification().
 * @param {object} fields status/msg/monitorId overrides
 * @returns {object} A dispensed (unstored) heartbeat bean
 */
function makeHeartbeatBean(fields) {
    const bean = R.dispense("heartbeat");
    bean.monitor_id = fields.monitorId;
    bean.status = fields.status;
    bean.msg = "msg" in fields ? fields.msg : "test message";
    bean.time = fields.time ?? dayjs.utc().format(SQL_DATETIME_FORMAT);
    bean.important = fields.important ?? false;
    bean.duration = 0;
    bean.retries = 0;
    bean.downCount = 0;
    return bean;
}

describe("Monitor.sendNotification / getNotificationList - characterization (pre ADR-0014)", () => {
    const testDb = new TestDB("./data/test-monitor-send-notification");
    /** @type {Array<{config: object, msg: string, monitorJSON: object, heartbeatJSON: object}>} */
    let sentCalls;
    let originalProviderList;

    before(async () => {
        await testDb.create();
        originalProviderList = Notification.providerList;
        Notification.providerList = {
            "test-fake": {
                send: async (notification, msg, monitorJSON, heartbeatJSON) => {
                    sentCalls.push({ config: notification, msg, monitorJSON, heartbeatJSON });
                    return "ok";
                },
            },
            "test-fake-throws": {
                send: async () => {
                    throw new Error("simulated provider failure");
                },
            },
        };
    });

    after(async () => {
        Notification.providerList = originalProviderList;
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    beforeEach(() => {
        sentCalls = [];
    });

    describe("getNotificationList()", () => {
        test("returns notifications linked to the monitor via monitor_notification", async () => {
            const monitor = await createMonitor({ name: "gnl-1" });
            const notifId = await createNotification({ name: "gnl-notif-1", type: "test-fake" });
            await linkNotification(monitor.id, notifId);

            const list = await Monitor.getNotificationList(monitor);

            assert.strictEqual(list.length, 1);
            assert.strictEqual(list[0].id, notifId);
            assert.strictEqual(list[0].name, "gnl-notif-1");
            assert.deepStrictEqual(JSON.parse(list[0].config), { name: "gnl-notif-1", type: "test-fake" });
        });

        test("returns an empty array when the monitor has no linked notifications", async () => {
            const monitor = await createMonitor({ name: "gnl-2-empty" });

            const list = await Monitor.getNotificationList(monitor);

            assert.deepStrictEqual(list, []);
        });

        test("does not return notifications linked to a different monitor (monitor_id scoping)", async () => {
            const monitorA = await createMonitor({ name: "gnl-3-a" });
            const monitorB = await createMonitor({ name: "gnl-3-b" });
            const notifForB = await createNotification({ name: "gnl-3-notif-b", type: "test-fake" });
            await linkNotification(monitorB.id, notifForB);

            const listForA = await Monitor.getNotificationList(monitorA);

            assert.deepStrictEqual(listForA, []);
        });
    });

    describe("sendNotification() - isFirstBeat/status guard clause", () => {
        test("isFirstBeat=true AND status=UP -> does NOT notify (the one skip case)", async () => {
            const monitor = await createMonitor({ name: "guard-first-up" });
            const notifId = await createNotification({ name: "guard-first-up-notif", type: "test-fake" });
            await linkNotification(monitor.id, notifId);
            const bean = makeHeartbeatBean({ monitorId: monitor.id, status: UP });

            await Monitor.sendNotification(true, monitor, bean);

            assert.strictEqual(sentCalls.length, 0);
        });

        test("isFirstBeat=true AND status=DOWN -> notifies", async () => {
            const monitor = await createMonitor({ name: "guard-first-down" });
            const notifId = await createNotification({ name: "guard-first-down-notif", type: "test-fake" });
            await linkNotification(monitor.id, notifId);
            const bean = makeHeartbeatBean({ monitorId: monitor.id, status: DOWN });

            await Monitor.sendNotification(true, monitor, bean);

            assert.strictEqual(sentCalls.length, 1);
        });

        test("isFirstBeat=false AND status=UP -> notifies", async () => {
            const monitor = await createMonitor({ name: "guard-notfirst-up" });
            const notifId = await createNotification({ name: "guard-notfirst-up-notif", type: "test-fake" });
            await linkNotification(monitor.id, notifId);
            const bean = makeHeartbeatBean({ monitorId: monitor.id, status: UP });

            await Monitor.sendNotification(false, monitor, bean);

            assert.strictEqual(sentCalls.length, 1);
        });

        test("isFirstBeat=false AND status=DOWN -> notifies", async () => {
            const monitor = await createMonitor({ name: "guard-notfirst-down" });
            const notifId = await createNotification({ name: "guard-notfirst-down-notif", type: "test-fake" });
            await linkNotification(monitor.id, notifId);
            const bean = makeHeartbeatBean({ monitorId: monitor.id, status: DOWN });

            await Monitor.sendNotification(false, monitor, bean);

            assert.strictEqual(sentCalls.length, 1);
        });
    });

    describe("sendNotification() - message text formatting", () => {
        test("status=UP produces the '✅ Up' text token", async () => {
            const monitor = await createMonitor({ name: "text-up" });
            const notifId = await createNotification({ name: "text-up-notif", type: "test-fake" });
            await linkNotification(monitor.id, notifId);
            const bean = makeHeartbeatBean({ monitorId: monitor.id, status: UP, msg: "all good" });

            await Monitor.sendNotification(false, monitor, bean);

            assert.strictEqual(sentCalls.length, 1);
            assert.strictEqual(sentCalls[0].msg, `[${monitor.name}] [✅ Up] all good`);
        });

        test("status=DOWN produces the '🔴 Down' text token", async () => {
            const monitor = await createMonitor({ name: "text-down" });
            const notifId = await createNotification({ name: "text-down-notif", type: "test-fake" });
            await linkNotification(monitor.id, notifId);
            const bean = makeHeartbeatBean({ monitorId: monitor.id, status: DOWN, msg: "connection refused" });

            await Monitor.sendNotification(true, monitor, bean);

            assert.strictEqual(sentCalls.length, 1);
            assert.strictEqual(sentCalls[0].msg, `[${monitor.name}] [🔴 Down] connection refused`);
        });

        test("status=PENDING (not UP, not the DOWN constant) still renders the 'Down' text -- current ternary is UP-vs-everything-else, not a real status check", async () => {
            const monitor = await createMonitor({ name: "text-pending" });
            const notifId = await createNotification({ name: "text-pending-notif", type: "test-fake" });
            await linkNotification(monitor.id, notifId);
            // isFirstBeat=false so the guard clause doesn't skip a non-UP/DOWN status.
            const bean = makeHeartbeatBean({ monitorId: monitor.id, status: PENDING, msg: "retrying" });

            await Monitor.sendNotification(false, monitor, bean);

            assert.strictEqual(sentCalls.length, 1);
            assert.strictEqual(sentCalls[0].msg, `[${monitor.name}] [🔴 Down] retrying`);
        });
    });

    describe("sendNotification() - dispatch to all linked notifications", () => {
        test("calls Notification.send once per linked notification, with parsed config + monitor JSON (includeSensitiveData=false) + heartbeat JSON", async () => {
            const monitor = await createMonitor({
                name: "dispatch-monitor",
                url: "https://dispatch.example.com",
                basic_auth_user: "should-not-leak",
            });
            const notifA = await createNotification({ name: "dispatch-a", type: "test-fake" });
            const notifB = await createNotification({ name: "dispatch-b", type: "test-fake" });
            await linkNotification(monitor.id, notifA);
            await linkNotification(monitor.id, notifB);
            const bean = makeHeartbeatBean({ monitorId: monitor.id, status: DOWN, msg: "down for dispatch test" });

            await Monitor.sendNotification(true, monitor, bean);

            assert.strictEqual(sentCalls.length, 2);
            const names = sentCalls.map((c) => c.config.name).sort();
            assert.deepStrictEqual(names, ["dispatch-a", "dispatch-b"]);

            for (const call of sentCalls) {
                assert.strictEqual(call.config.type, "test-fake");
                assert.strictEqual(call.monitorJSON.id, monitor.id);
                assert.strictEqual(call.monitorJSON.name, "dispatch-monitor");
                // monitor.toJSON(preloadData, false) -- sensitive fields absent (ADR-0007 current reality).
                assert.strictEqual("basic_auth_user" in call.monitorJSON, false);
                assert.strictEqual(call.heartbeatJSON.status, DOWN);
                assert.strictEqual(call.heartbeatJSON.msg, "down for dispatch test");
            }
        });

        test("one notification throwing does not stop the others from being sent (per-notification try/catch)", async () => {
            const monitor = await createMonitor({ name: "resilience-monitor" });
            const throwingNotifId = await createNotification({ name: "resilience-throws", type: "test-fake-throws" });
            const okNotifId = await createNotification({ name: "resilience-ok", type: "test-fake" });
            await linkNotification(monitor.id, throwingNotifId);
            await linkNotification(monitor.id, okNotifId);
            const bean = makeHeartbeatBean({ monitorId: monitor.id, status: DOWN });

            // Must not reject/throw out of sendNotification even though one provider throws.
            await assert.doesNotReject(Monitor.sendNotification(true, monitor, bean));

            assert.strictEqual(sentCalls.length, 1);
            assert.strictEqual(sentCalls[0].config.name, "resilience-ok");
        });

        test("heartbeatJSON.msg defaults to 'N/A' when bean.msg is falsy", async () => {
            const monitor = await createMonitor({ name: "empty-msg-monitor" });
            const notifId = await createNotification({ name: "empty-msg-notif", type: "test-fake" });
            await linkNotification(monitor.id, notifId);
            const bean = makeHeartbeatBean({ monitorId: monitor.id, status: DOWN, msg: "" });

            await Monitor.sendNotification(true, monitor, bean);

            assert.strictEqual(sentCalls.length, 1);
            assert.strictEqual(sentCalls[0].heartbeatJSON.msg, "N/A");
            // The rendered text still carries the original (empty) msg -- only heartbeatJSON is patched.
            assert.strictEqual(sentCalls[0].msg, `[${monitor.name}] [🔴 Down] `);
        });
    });

    describe("sendNotification() - lastDownTime enrichment", () => {
        test("status=UP with a prior important DOWN heartbeat -> heartbeatJSON.lastDownTime is populated", async () => {
            const monitor = await createMonitor({ name: "lastdown-populated" });
            const notifId = await createNotification({ name: "lastdown-populated-notif", type: "test-fake" });
            await linkNotification(monitor.id, notifId);

            const downTime = dayjs.utc().subtract(1, "hour").format(SQL_DATETIME_FORMAT);
            const priorDownBean = makeHeartbeatBean({
                monitorId: monitor.id,
                status: DOWN,
                important: true,
                time: downTime,
            });
            await R.store(priorDownBean);

            const upBean = makeHeartbeatBean({ monitorId: monitor.id, status: UP, msg: "recovered" });
            await Monitor.sendNotification(false, monitor, upBean);

            assert.strictEqual(sentCalls.length, 1);
            assert.strictEqual(sentCalls[0].heartbeatJSON.lastDownTime, downTime);
        });

        test("status=DOWN -> lastDownTime is never computed (guarded to the UP branch only)", async () => {
            const monitor = await createMonitor({ name: "lastdown-not-down-status" });
            const notifId = await createNotification({ name: "lastdown-not-down-status-notif", type: "test-fake" });
            await linkNotification(monitor.id, notifId);

            const priorDownBean = makeHeartbeatBean({
                monitorId: monitor.id,
                status: DOWN,
                important: true,
                time: dayjs.utc().subtract(1, "hour").format(SQL_DATETIME_FORMAT),
            });
            await R.store(priorDownBean);

            const stillDownBean = makeHeartbeatBean({ monitorId: monitor.id, status: DOWN, msg: "still down" });
            await Monitor.sendNotification(true, monitor, stillDownBean);

            assert.strictEqual(sentCalls.length, 1);
            assert.strictEqual("lastDownTime" in sentCalls[0].heartbeatJSON, false);
        });

        test("status=UP with no prior DOWN heartbeat -> lastDownTime is absent, no crash", async () => {
            const monitor = await createMonitor({ name: "lastdown-none" });
            const notifId = await createNotification({ name: "lastdown-none-notif", type: "test-fake" });
            await linkNotification(monitor.id, notifId);
            const bean = makeHeartbeatBean({ monitorId: monitor.id, status: UP });

            await assert.doesNotReject(Monitor.sendNotification(false, monitor, bean));

            assert.strictEqual(sentCalls.length, 1);
            assert.strictEqual("lastDownTime" in sentCalls[0].heartbeatJSON, false);
        });
    });
});
