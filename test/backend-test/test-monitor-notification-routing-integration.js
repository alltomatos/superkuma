process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const Monitor = require("../../server/model/monitor");
const { Notification } = require("../../server/notification");
const { Settings } = require("../../server/settings");
const { DOWN, SQL_DATETIME_FORMAT } = require("../../src/util");

dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

/**
 * Integration coverage for Monitor.getRoutedNotificationList()/sendNotification()
 * WITH notification_route rows present (ADR-0014, TASK-A0-3). Complements
 * test-monitor-send-notification.js, which pins the pre-ADR-0014 legacy
 * behavior (and, by construction, the empty-routes short-circuit).
 * @param {object} fields Monitor fields to assign
 * @returns {Promise<Monitor>} The stored monitor bean, reloaded from the DB
 */
async function createMonitor(fields) {
    let bean = R.dispense("monitor");
    bean.import({
        name: "routing test monitor",
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

let teamCounter = 0;

/**
 * Create a fresh, uniquely-slugged team. Each test uses its own team so a
 * team-scoped notification_route created in one test can never leak into a
 * later test sharing this file's one DB (only globally-scoped, team_id=null
 * routes cross that boundary, and only one test deliberately creates one).
 * @returns {Promise<number>} The new team's id
 */
async function createTeam() {
    teamCounter += 1;
    const slug = `routing-test-team-${teamCounter}`;
    await R.knex("team").insert({ name: slug, slug, is_system: false, active: true });
    return (await R.knex("team").where("slug", slug).first()).id;
}

let testUserIdPromise;

/**
 * Lazily create a minimal user row to satisfy notification.user_id's NOT NULL
 * constraint, same as test-monitor-send-notification.js.
 *
 * Caches the in-flight promise, not just the resolved id -- see the longer
 * note on the sibling helper in test-monitor-send-notification.js for why
 * caching only the resolved value races when node:test runs this file's
 * top-level tests concurrently.
 * @returns {Promise<number>} The test user's id
 */
function getTestUserId() {
    if (!testUserIdPromise) {
        testUserIdPromise = (async () => {
            await R.knex("user").insert({ username: "routing-baseline-owner", password: "x" });
            return (await R.knex("user").where("username", "routing-baseline-owner").first()).id;
        })();
    }
    return testUserIdPromise;
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
async function linkStaticNotification(monitorId, notificationId) {
    await R.knex("monitor_notification").insert({ monitor_id: monitorId, notification_id: notificationId });
}

/**
 * Insert a notification_route row.
 * @param {object} fields team_id/min_severity/monitor_id/tag_id/notification_id overrides
 * @returns {Promise<void>}
 */
async function createRoute(fields) {
    await R.knex("notification_route").insert({
        team_id: fields.team_id ?? null,
        min_severity: fields.min_severity ?? "critical",
        monitor_id: fields.monitor_id ?? null,
        tag_id: fields.tag_id ?? null,
        notification_id: fields.notification_id,
    });
}

/**
 * Build an in-memory (not stored) heartbeat bean matching the shape
 * Monitor.beat() constructs.
 * @param {object} fields status/msg/monitorId overrides
 * @returns {object} A dispensed (unstored) heartbeat bean
 */
function makeHeartbeatBean(fields) {
    const bean = R.dispense("heartbeat");
    bean.monitor_id = fields.monitorId;
    bean.status = fields.status;
    bean.msg = "msg" in fields ? fields.msg : "routing test message";
    bean.time = fields.time ?? dayjs.utc().format(SQL_DATETIME_FORMAT);
    bean.important = fields.important ?? false;
    bean.duration = 0;
    bean.retries = 0;
    bean.downCount = 0;
    return bean;
}

describe("Monitor.getRoutedNotificationList()/sendNotification() - notification_route integration (ADR-0014)", () => {
    const testDb = new TestDB("./data/test-monitor-notification-routing-integration");
    /** @type {Array<{config: object}>} */
    let sentCalls;
    let originalProviderList;

    before(async () => {
        await testDb.create();

        originalProviderList = Notification.providerList;
        Notification.providerList = {
            "test-fake": {
                send: async (notification) => {
                    sentCalls.push({ config: notification });
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

    test("no notification_route rows -> getRoutedNotificationList returns exactly the legacy static list", async () => {
        const teamId = await createTeam();
        const monitor = await createMonitor({ name: "no-routes", team_id: teamId });
        const notifId = await createNotification("no-routes-notif");
        await linkStaticNotification(monitor.id, notifId);

        const result = await Monitor.getRoutedNotificationList(monitor);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, notifId);
    });

    test("a route scoped to a DIFFERENT team does not fire", async () => {
        const monitorTeamId = await createTeam();
        const otherTeamId = await createTeam();

        const monitor = await createMonitor({ name: "cross-team-monitor", team_id: monitorTeamId });
        const routedNotifId = await createNotification("cross-team-notif");
        await createRoute({ team_id: otherTeamId, min_severity: "critical", notification_id: routedNotifId });

        const bean = makeHeartbeatBean({ monitorId: monitor.id, status: DOWN });
        await Monitor.sendNotification(true, monitor, bean);

        assert.strictEqual(sentCalls.length, 0, "a different team's route must not fire for this monitor");
    });

    test("route min_severity above the monitor's alert_severity does not fire", async () => {
        const teamId = await createTeam();
        const monitor = await createMonitor({ name: "low-severity-monitor", team_id: teamId, alert_severity: "warning" });
        const routedNotifId = await createNotification("critical-only-notif");
        await createRoute({ team_id: teamId, min_severity: "critical", notification_id: routedNotifId });

        const bean = makeHeartbeatBean({ monitorId: monitor.id, status: DOWN });
        await Monitor.sendNotification(true, monitor, bean);

        assert.strictEqual(sentCalls.length, 0, "a 'warning' monitor must not trigger a 'critical'-only route");
    });

    test("route min_severity at or below the monitor's alert_severity fires", async () => {
        const teamId = await createTeam();
        const monitor = await createMonitor({ name: "matching-severity-monitor", team_id: teamId, alert_severity: "critical" });
        const routedNotifId = await createNotification("warning-threshold-notif");
        await createRoute({ team_id: teamId, min_severity: "warning", notification_id: routedNotifId });

        const bean = makeHeartbeatBean({ monitorId: monitor.id, status: DOWN });
        await Monitor.sendNotification(true, monitor, bean);

        assert.strictEqual(sentCalls.length, 1);
        assert.strictEqual(sentCalls[0].config.name, "warning-threshold-notif");
    });

    test("a route scoped to a specific monitor_id only fires for that monitor", async () => {
        const teamId = await createTeam();
        const targetMonitor = await createMonitor({ name: "route-target-monitor", team_id: teamId });
        const otherMonitor = await createMonitor({ name: "route-non-target-monitor", team_id: teamId });
        const routedNotifId = await createNotification("monitor-scoped-notif");
        await createRoute({ team_id: teamId, monitor_id: targetMonitor.id, notification_id: routedNotifId });

        const beanForTarget = makeHeartbeatBean({ monitorId: targetMonitor.id, status: DOWN });
        await Monitor.sendNotification(true, targetMonitor, beanForTarget);
        assert.strictEqual(sentCalls.length, 1, "route should fire for its exact monitor_id");

        sentCalls = [];
        const beanForOther = makeHeartbeatBean({ monitorId: otherMonitor.id, status: DOWN });
        await Monitor.sendNotification(true, otherMonitor, beanForOther);
        assert.strictEqual(sentCalls.length, 0, "route must not fire for a different monitor_id");
    });

    test("a route scoped to a tag only fires for monitors carrying that tag", async () => {
        const teamId = await createTeam();
        await R.knex("tag").insert({ name: "routing-test-tag", color: "#123456" });
        const tagId = (await R.knex("tag").where("name", "routing-test-tag").first()).id;

        const taggedMonitor = await createMonitor({ name: "tagged-monitor", team_id: teamId });
        await R.knex("monitor_tag").insert({ monitor_id: taggedMonitor.id, tag_id: tagId });
        const untaggedMonitor = await createMonitor({ name: "untagged-monitor", team_id: teamId });

        const routedNotifId = await createNotification("tag-scoped-notif");
        await createRoute({ team_id: teamId, tag_id: tagId, notification_id: routedNotifId });

        const beanForTagged = makeHeartbeatBean({ monitorId: taggedMonitor.id, status: DOWN });
        await Monitor.sendNotification(true, taggedMonitor, beanForTagged);
        assert.strictEqual(sentCalls.length, 1, "route should fire for a monitor carrying the tag");

        sentCalls = [];
        const beanForUntagged = makeHeartbeatBean({ monitorId: untaggedMonitor.id, status: DOWN });
        await Monitor.sendNotification(true, untaggedMonitor, beanForUntagged);
        assert.strictEqual(sentCalls.length, 0, "route must not fire for a monitor without the tag");
    });

    test("a route pointing at a notification ALREADY in the static list does not duplicate the send", async () => {
        const teamId = await createTeam();
        const monitor = await createMonitor({ name: "dedup-monitor", team_id: teamId });
        const notifId = await createNotification("dedup-notif");
        await linkStaticNotification(monitor.id, notifId);
        await createRoute({ team_id: teamId, notification_id: notifId });

        const bean = makeHeartbeatBean({ monitorId: monitor.id, status: DOWN });
        await Monitor.sendNotification(true, monitor, bean);

        assert.strictEqual(sentCalls.length, 1, "the same notification must only be sent once");
    });

    test("getRoutedNotificationList() severityOverride param: omitting it still uses monitor.alert_severity exactly as before (no regression)", async () => {
        const teamId = await createTeam();
        const monitor = await createMonitor({ name: "override-omitted-monitor", team_id: teamId, alert_severity: "critical" });
        const routedNotifId = await createNotification("override-omitted-notif");
        await createRoute({ team_id: teamId, min_severity: "warning", notification_id: routedNotifId });

        const result = await Monitor.getRoutedNotificationList(monitor);

        assert.strictEqual(result.length, 1, "route min_severity <= monitor.alert_severity should still match with no override arg");
        assert.strictEqual(result[0].name, "override-omitted-notif");
    });

    test("getRoutedNotificationList() severityOverride param: passing an override routes on it INSTEAD of monitor.alert_severity", async () => {
        const teamId = await createTeam();
        // monitor.alert_severity is 'warning' -- alone, this would NOT satisfy a 'critical'-only route.
        const monitor = await createMonitor({ name: "override-applied-monitor", team_id: teamId, alert_severity: "warning" });
        const routedNotifId = await createNotification("override-applied-notif");
        await createRoute({ team_id: teamId, min_severity: "critical", notification_id: routedNotifId });

        const withoutOverride = await Monitor.getRoutedNotificationList(monitor);
        assert.strictEqual(
            withoutOverride.length,
            0,
            "sanity: without an override, the monitor's own 'warning' severity does not satisfy the 'critical' route"
        );

        const withOverride = await Monitor.getRoutedNotificationList(monitor, "critical");
        assert.strictEqual(withOverride.length, 1, "an explicit 'critical' override should satisfy the 'critical' route");
        assert.strictEqual(withOverride[0].name, "override-applied-notif");
    });

    // Deliberately LAST: this route is unscoped (team_id/monitor_id/tag_id all
    // null), so once created it matches every monitor for the rest of the
    // file's shared DB. Every other test above uses a team/monitor/tag-scoped
    // route so it isn't affected by running before this one.
    test("a global route (all-null selectors) fires for any monitor/team, adding a notification beyond the static list", async () => {
        const teamId = await createTeam();
        const monitor = await createMonitor({ name: "global-route-monitor", team_id: teamId });
        const routedNotifId = await createNotification("global-route-notif");
        await createRoute({ min_severity: "critical", notification_id: routedNotifId });

        const bean = makeHeartbeatBean({ monitorId: monitor.id, status: DOWN });
        await Monitor.sendNotification(true, monitor, bean);

        assert.strictEqual(sentCalls.length, 1);
        assert.strictEqual(sentCalls[0].config.name, "global-route-notif");
    });
});
