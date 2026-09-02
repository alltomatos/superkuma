process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const Monitor = require("../../server/model/monitor");
const { Notification } = require("../../server/notification");
const { Settings } = require("../../server/settings");
const { UP, DOWN, SQL_DATETIME_FORMAT } = require("../../src/util");

dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

/**
 * Integration coverage for Monitor.evaluateWarningThreshold() (the disk-alert
 * severity extension of ADR-0014), the beat()-adjacent wiring that evaluates
 * a metric monitor's optional "Alerta" band and, decoupled from
 * bean.status/up/down accounting, persists an alert_event and notifies.
 * Structure/helpers mirror test-monitor-anomaly-detection.js closely -- the
 * same beat()-adjacent, dark-launch-by-default shape.
 * @param {object} fields Monitor fields to assign (snake_case, matching bean column names)
 * @returns {Promise<Monitor>} The stored monitor bean, reloaded from the DB
 */
async function createMonitor(fields) {
    let bean = R.dispense("monitor");
    bean.import({
        name: "warning threshold test monitor",
        type: "prometheus",
        url: "http://prometheus.example.com:9090",
        interval: 20,
        maxretries: 0,
        jsonPathOperator: ">=",
        expectedValue: "10",
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

let testUserId;

/**
 * Lazily create a minimal user row to satisfy notification.user_id's NOT
 * NULL constraint, same idiom as test-monitor-anomaly-detection.js.
 * @returns {Promise<number>} The test user's id
 */
async function getTestUserId() {
    if (testUserId === undefined) {
        await R.knex("user").insert({ username: "warning-threshold-owner", password: "x" });
        testUserId = (await R.knex("user").where("username", "warning-threshold-owner").first()).id;
    }
    return testUserId;
}

/**
 * Dispense + store a notification bean using the "test-fake" provider type
 * registered by this file's before().
 * @param {string} name The notification's name (also embedded in its config).
 * @returns {Promise<number>} The stored notification's id
 */
async function createNotification(name) {
    const bean = R.dispense("notification");
    bean.name = name;
    bean.config = JSON.stringify({ name, type: "test-fake" });
    bean.user_id = await getTestUserId();
    bean.active = true;
    bean.is_default = false;
    return await R.store(bean);
}

/**
 * Link a notification to a monitor via the legacy monitor_notification table.
 * @param {number} monitorId The monitor's id
 * @param {number} notificationId The notification's id
 * @returns {Promise<void>}
 */
async function linkNotification(monitorId, notificationId) {
    await R.knex("monitor_notification").insert({ monitor_id: monitorId, notification_id: notificationId });
}

/**
 * Build an in-memory (not stored) heartbeat bean matching the shape
 * Monitor.beat() constructs for a prometheus monitor's success message.
 * @param {object} fields status/msg/monitorId overrides
 * @returns {object} A dispensed (unstored) heartbeat bean
 */
function makeHeartbeatBean(fields) {
    const bean = R.dispense("heartbeat");
    bean.monitor_id = fields.monitorId;
    bean.status = fields.status;
    bean.ping = fields.ping ?? 0;
    bean.msg = fields.msg;
    bean.time = fields.time ?? dayjs.utc().format(SQL_DATETIME_FORMAT);
    bean.important = fields.important ?? false;
    bean.duration = 0;
    bean.retries = 0;
    bean.downCount = fields.downCount ?? 0;
    return bean;
}

describe("Monitor.evaluateWarningThreshold() - disk alert severity (ADR-0014 extension)", () => {
    const testDb = new TestDB("./data/test-monitor-warning-threshold");
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

    test("warning_value unset (the default) -> complete no-op, even with a value inside what would be the warning band", async () => {
        const monitor = await createMonitor({ name: "warning-disabled" });
        assert.strictEqual(monitor.warning_value, null, "sanity: migration default is null");

        const bean = makeHeartbeatBean({
            monitorId: monitor.id,
            status: UP,
            msg: "PromQL condition passes (15 >= 10)",
        });

        await assert.doesNotReject(Monitor.evaluateWarningThreshold(monitor, bean));

        const events = await R.knex("alert_event").where("monitor_id", monitor.id).select();
        assert.strictEqual(events.length, 0, "no alert_event row created -- guaranteed no-op");
        assert.strictEqual(sentCalls.length, 0, "no notification sent -- guaranteed no-op");
    });

    test("bean.status is DOWN -> no-op (the critical alert already fired for this beat)", async () => {
        const monitor = await createMonitor({ name: "warning-down-beat", warning_value: 30 });
        const bean = makeHeartbeatBean({
            monitorId: monitor.id,
            status: DOWN,
            msg: "PromQL condition does not pass (5 >= 10)",
        });

        await assert.doesNotReject(Monitor.evaluateWarningThreshold(monitor, bean));

        const events = await R.knex("alert_event").where("monitor_id", monitor.id).select();
        assert.strictEqual(events.length, 0);
        assert.strictEqual(sentCalls.length, 0);
    });

    test("monitor type not in Heartbeat.METRIC_MONITOR_TYPES -> no-op even with warning_value set", async () => {
        const monitor = await createMonitor({ name: "warning-wrong-type", type: "http", warning_value: 30 });
        const bean = makeHeartbeatBean({ monitorId: monitor.id, status: UP, msg: "200 OK" });

        await assert.doesNotReject(Monitor.evaluateWarningThreshold(monitor, bean));

        const events = await R.knex("alert_event").where("monitor_id", monitor.id).select();
        assert.strictEqual(events.length, 0);
        assert.strictEqual(sentCalls.length, 0);
    });

    test("value comfortably inside the safe zone (still satisfies warning_value) -> no alert_event, no notification", async () => {
        const monitor = await createMonitor({ name: "warning-safe", warning_value: 30 });
        const bean = makeHeartbeatBean({
            monitorId: monitor.id,
            status: UP,
            msg: "PromQL condition passes (180.00 >= 10) — livre 180.00 GB de 500 GB total (T:)",
        });

        await Monitor.evaluateWarningThreshold(monitor, bean);

        const events = await R.knex("alert_event").where("monitor_id", monitor.id).select();
        assert.strictEqual(events.length, 0, "180 >= warning_value 30 -- still safe");
        assert.strictEqual(sentCalls.length, 0);
    });

    test("value inside the warning band (below warning_value, still above critical) -> creates alert_event and notifies, monitor stays UP", async () => {
        const monitor = await createMonitor({
            name: "warning-fires",
            warning_value: 30,
        });
        const notifId = await createNotification("warning-fires-notif");
        await linkNotification(monitor.id, notifId);

        const bean = makeHeartbeatBean({
            monitorId: monitor.id,
            status: UP,
            msg: "PromQL condition passes (25.00 >= 10) — livre 25.00 GB de 500 GB total (T:)",
        });

        await Monitor.evaluateWarningThreshold(monitor, bean);

        const events = await R.knex("alert_event").where("monitor_id", monitor.id).select();
        assert.strictEqual(events.length, 1, "one alert_event row should be created");
        assert.strictEqual(events[0].type, "warning_threshold");
        assert.strictEqual(events[0].monitor_id, monitor.id);
        assert.strictEqual(events[0].severity, "warning");
        assert.strictEqual(Number(events[0].value), 25);
        assert.strictEqual(Number(events[0].expected), 30);

        assert.strictEqual(sentCalls.length, 1, "the routed notification should fire");
        assert.match(sentCalls[0].msg, /\[⚠️ Alerta\]/);
        assert.strictEqual(sentCalls[0].monitorJSON.id, monitor.id);
        assert.strictEqual(sentCalls[0].heartbeatJSON.status, UP, "warning notification still reports status UP");
        assert.strictEqual(
            sentCalls[0].heartbeatJSON.alertBand,
            "warning",
            "alertBand lets templates show Alerta instead of the raw Up status"
        );

        assert.strictEqual(bean.status, UP, "bean.status must remain UP -- a warning is never a DOWN");
    });

    test("cooldown-window alert_event already exists -> no duplicate notification", async () => {
        const monitor = await createMonitor({ name: "warning-cooldown", warning_value: 30 });
        const notifId = await createNotification("warning-cooldown-notif");
        await linkNotification(monitor.id, notifId);

        await R.knex("alert_event").insert({
            monitor_id: monitor.id,
            type: "warning_threshold",
            value: 20,
            expected: 30,
            score: 0,
            severity: "warning",
            time: R.isoDateTimeMillis(dayjs.utc()),
        });

        const bean = makeHeartbeatBean({
            monitorId: monitor.id,
            status: UP,
            msg: "PromQL condition passes (18.00 >= 10)",
        });

        await Monitor.evaluateWarningThreshold(monitor, bean);

        const events = await R.knex("alert_event").where("monitor_id", monitor.id).select();
        assert.strictEqual(events.length, 1, "cooldown must prevent a second alert_event from being created");
        assert.strictEqual(sentCalls.length, 0, "cooldown must prevent a duplicate notification");
    });

    test("value below warning_value but no route/static notification linked -> alert_event still recorded, nothing sent", async () => {
        const monitor = await createMonitor({ name: "warning-no-notif", warning_value: 30 });
        const bean = makeHeartbeatBean({
            monitorId: monitor.id,
            status: UP,
            msg: "PromQL condition passes (25.00 >= 10)",
        });

        await Monitor.evaluateWarningThreshold(monitor, bean);

        const events = await R.knex("alert_event").where("monitor_id", monitor.id).select();
        assert.strictEqual(events.length, 1, "alert_event is recorded regardless of whether anyone is notified");
        assert.strictEqual(sentCalls.length, 0, "no notifications configured -> nothing sent");
    });
});
