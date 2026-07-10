process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const Monitor = require("../../server/model/monitor");
const { UptimeCalculator } = require("../../server/uptime-calculator");
const { Notification } = require("../../server/notification");
const { Settings } = require("../../server/settings");
const { UP, SQL_DATETIME_FORMAT } = require("../../src/util");

dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

/**
 * Integration coverage for Monitor.evaluateAnomaly() (ADR-0013, TASK-A1-3),
 * the beat()-adjacent wiring that evaluates a response-time anomaly and,
 * decoupled from bean.status/up/down accounting, persists an alert_event and
 * notifies. Structure/helpers mirror
 * test-monitor-notification-routing-integration.js closely. The
 * UptimeCalculator itself is manipulated directly (in-memory, no DB writes
 * under TEST_BACKEND) the same way
 * test-uptime-calculator-anomaly-window.js does, rather than driving the
 * full beat() pipeline (network I/O, retries, etc.) which is out of scope
 * for this file.
 * @param {object} fields Monitor fields to assign (snake_case, matching bean column names)
 * @returns {Promise<Monitor>} The stored monitor bean, reloaded from the DB
 */
async function createMonitor(fields) {
    let bean = R.dispense("monitor");
    bean.import({
        name: "anomaly test monitor",
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

let testUserId;

/**
 * Lazily create a minimal user row to satisfy notification.user_id's NOT
 * NULL constraint, same idiom as test-monitor-send-notification.js.
 * @returns {Promise<number>} The test user's id
 */
async function getTestUserId() {
    if (testUserId === undefined) {
        await R.knex("user").insert({ username: "anomaly-baseline-owner", password: "x" });
        testUserId = (await R.knex("user").where("username", "anomaly-baseline-owner").first()).id;
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
 * Monitor.beat() constructs, extended with a `ping` field (which the
 * notification-routing characterization files never needed).
 * @param {object} fields status/ping/msg/monitorId overrides
 * @returns {object} A dispensed (unstored) heartbeat bean
 */
function makeHeartbeatBean(fields) {
    const bean = R.dispense("heartbeat");
    bean.monitor_id = fields.monitorId;
    bean.status = fields.status;
    bean.ping = fields.ping ?? 0;
    bean.msg = "msg" in fields ? fields.msg : "anomaly test message";
    bean.time = fields.time ?? dayjs.utc().format(SQL_DATETIME_FORMAT);
    bean.important = fields.important ?? false;
    bean.duration = 0;
    bean.retries = 0;
    bean.downCount = fields.downCount ?? 0;
    return bean;
}

/**
 * Fabricate a run of "normal" per-minute history directly on a real
 * UptimeCalculator, mirroring test-uptime-calculator-anomaly-window.js's
 * direct-manipulation style: each call advances
 * UptimeCalculator.currentDate by one minute and writes one UP sample.
 * @param {UptimeCalculator} calc The calculator to write into.
 * @param {dayjs.Dayjs} startDate The first minute to write.
 * @param {number[]} pings One ping value per minute, written in order.
 * @returns {dayjs.Dayjs} The next (as yet unused) minute after the last write.
 */
async function seedMinutelyHistory(calc, startDate, pings) {
    let date = startDate;
    for (const ping of pings) {
        UptimeCalculator.currentDate = date;
        await calc.update(UP, ping);
        date = date.add(1, "minute");
    }
    return date;
}

describe("Monitor.evaluateAnomaly() - anomaly detection wiring (ADR-0013)", () => {
    const testDb = new TestDB("./data/test-monitor-anomaly-detection");
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

    test("anomaly_enabled=false (the default) -> evaluateAnomaly is a complete no-op, even with a wildly anomalous ping AND plenty of history to detect it", async () => {
        const monitor = await createMonitor({ name: "anomaly-disabled", anomaly_window: 5 });
        assert.strictEqual(!!monitor.anomaly_enabled, false, "sanity: migration default is false");

        const notifId = await createNotification("anomaly-disabled-notif");
        await linkNotification(monitor.id, notifId);

        const calc = new UptimeCalculator();
        // Deliberately seed enough tight, "normal" history that a wild spike
        // WOULD be flagged if the anomaly_enabled gate weren't there -- an
        // earlier version of this test only wrote one sample, so
        // historicalSamples was empty regardless of the gate and the
        // assertions below held for the wrong reason (detectAnomaly()'s own
        // "not enough data" null-return, not the dark-launch gate). Caught by
        // an adversarial mutation-check that removed the gate and still saw
        // this test pass -- see ADR-0013 TASK-A1-3's governance log.
        const nextDate = await seedMinutelyHistory(calc, dayjs.utc("2026-02-01T00:00:00.000Z"), [
            100, 102, 98, 101, 99,
        ]);
        UptimeCalculator.currentDate = nextDate;
        const wildPing = 999999;
        await calc.update(UP, wildPing);

        const bean = makeHeartbeatBean({ monitorId: monitor.id, status: UP, ping: wildPing });

        await assert.doesNotReject(Monitor.evaluateAnomaly(monitor, bean, calc));

        const events = await R.knex("alert_event").where("monitor_id", monitor.id).select();
        assert.strictEqual(events.length, 0, "no alert_event row created -- guaranteed no-op");
        assert.strictEqual(sentCalls.length, 0, "no notification sent -- guaranteed no-op");
    });

    test("anomaly_enabled=true with a clear anomalous ping creates an alert_event and notifies", async () => {
        const monitor = await createMonitor({
            name: "anomaly-fires",
            anomaly_enabled: true,
            anomaly_window: 5,
            anomaly_z_threshold: 2.5,
            anomaly_direction: "both",
            anomaly_severity: "critical",
        });
        const notifId = await createNotification("anomaly-fires-notif");
        await linkNotification(monitor.id, notifId);

        const calc = new UptimeCalculator();
        const nextDate = await seedMinutelyHistory(calc, dayjs.utc("2026-02-02T00:00:00.000Z"), [
            100, 102, 98, 101, 99,
        ]);

        UptimeCalculator.currentDate = nextDate;
        const badPing = 5000;
        // Mirrors beat()'s own call site: uptimeCalculator.update() runs BEFORE evaluateAnomaly().
        await calc.update(UP, badPing);

        const bean = makeHeartbeatBean({ monitorId: monitor.id, status: UP, ping: badPing });

        await Monitor.evaluateAnomaly(monitor, bean, calc);

        const events = await R.knex("alert_event").where("monitor_id", monitor.id).select();
        assert.strictEqual(events.length, 1, "one alert_event row should be created");
        assert.strictEqual(events[0].type, "anomaly");
        assert.strictEqual(events[0].monitor_id, monitor.id);
        assert.strictEqual(events[0].severity, "critical", "severity copied from monitor.anomaly_severity");
        assert.strictEqual(Number(events[0].value), badPing);
        assert.ok(Number(events[0].expected) < 200, "expected should reflect the ~100ms baseline, not the spike");
        assert.ok(Number(events[0].score) > 2.5, "score should exceed the configured z-threshold");

        assert.strictEqual(sentCalls.length, 1, "the routed notification should fire");
        assert.match(sentCalls[0].msg, /\[Anomaly\]/);
        assert.strictEqual(sentCalls[0].monitorJSON.id, monitor.id);
        assert.strictEqual(sentCalls[0].heartbeatJSON.status, UP, "anomaly notification still reports status UP");
    });

    test("anomaly_enabled=true but not enough historical data yet -> no crash, no alert_event, no notification", async () => {
        const monitor = await createMonitor({
            name: "anomaly-first-beat",
            anomaly_enabled: true,
            anomaly_window: 5,
        });
        const notifId = await createNotification("anomaly-first-beat-notif");
        await linkNotification(monitor.id, notifId);

        const calc = new UptimeCalculator();
        UptimeCalculator.currentDate = dayjs.utc("2026-02-03T00:00:00.000Z");
        const ping = 100;
        await calc.update(UP, ping);

        const bean = makeHeartbeatBean({ monitorId: monitor.id, status: UP, ping });

        await assert.doesNotReject(Monitor.evaluateAnomaly(monitor, bean, calc));

        const events = await R.knex("alert_event").where("monitor_id", monitor.id).select();
        assert.strictEqual(events.length, 0, "not enough history -> no alert_event");
        assert.strictEqual(sentCalls.length, 0, "not enough history -> no notification");
    });

    test("anomaly_enabled=true, an anomalous ping, but a cooldown-window alert_event already exists -> no duplicate", async () => {
        const monitor = await createMonitor({
            name: "anomaly-cooldown",
            anomaly_enabled: true,
            anomaly_window: 5,
            anomaly_z_threshold: 2.5,
            anomaly_severity: "critical",
        });
        const notifId = await createNotification("anomaly-cooldown-notif");
        await linkNotification(monitor.id, notifId);

        // A recent (real "now") anomaly event already on record for this monitor.
        await R.knex("alert_event").insert({
            monitor_id: monitor.id,
            type: "anomaly",
            value: 4000,
            expected: 100,
            score: 10,
            severity: "critical",
            time: R.isoDateTimeMillis(dayjs.utc()),
        });

        const calc = new UptimeCalculator();
        const nextDate = await seedMinutelyHistory(calc, dayjs.utc("2026-02-04T00:00:00.000Z"), [
            100, 102, 98, 101, 99,
        ]);
        UptimeCalculator.currentDate = nextDate;
        const badPing = 5000;
        await calc.update(UP, badPing);

        const bean = makeHeartbeatBean({ monitorId: monitor.id, status: UP, ping: badPing });

        await Monitor.evaluateAnomaly(monitor, bean, calc);

        const events = await R.knex("alert_event").where("monitor_id", monitor.id).select();
        assert.strictEqual(events.length, 1, "cooldown must prevent a second alert_event from being created");
        assert.strictEqual(sentCalls.length, 0, "cooldown must prevent a duplicate notification");
    });

    test("an anomaly firing does not affect bean.status/up/down counters (anomaly != downtime invariant)", async () => {
        const monitor = await createMonitor({
            name: "anomaly-invariant",
            anomaly_enabled: true,
            anomaly_window: 5,
            anomaly_z_threshold: 2.5,
            anomaly_severity: "warning",
        });
        const notifId = await createNotification("anomaly-invariant-notif");
        await linkNotification(monitor.id, notifId);

        const calc = new UptimeCalculator();
        const nextDate = await seedMinutelyHistory(calc, dayjs.utc("2026-02-05T00:00:00.000Z"), [
            100, 102, 98, 101, 99,
        ]);
        UptimeCalculator.currentDate = nextDate;
        const badPing = 5000;
        await calc.update(UP, badPing);

        const bean = makeHeartbeatBean({ monitorId: monitor.id, status: UP, ping: badPing, downCount: 0 });
        const upCountBefore = calc.getDataArray(1, "minute")[0].up;

        await Monitor.evaluateAnomaly(monitor, bean, calc);

        assert.strictEqual(bean.status, UP, "bean.status must remain UP");
        assert.strictEqual(bean.downCount, 0, "downCount must be untouched by anomaly evaluation");
        assert.strictEqual(bean.important, false, "important flag must be untouched by anomaly evaluation");

        const upCountAfter = calc.getDataArray(1, "minute")[0].up;
        assert.strictEqual(
            upCountAfter,
            upCountBefore,
            "evaluateAnomaly must not write another sample into uptimeCalculator"
        );

        // Sanity: confirm the anomaly did fire in this test, so the assertions above
        // are proving the invariant actually held DURING a real anomaly, not just
        // that nothing happens when nothing happens.
        const events = await R.knex("alert_event").where("monitor_id", monitor.id).select();
        assert.strictEqual(events.length, 1);
    });
});
