process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const dayjs = require("dayjs");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { clearOldData } = require("../../server/jobs/clear-old-data");

const testDb = new TestDB("./data/test-clear-old-data");

describe("clearOldData() stat_monthly retention", () => {
    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("deletes stat_monthly rows older than keepMonthlyStatsPeriodDays, keeps newer ones", async () => {
        let monitor = R.dispense("monitor");
        monitor.name = "Clear Old Data Monitor";
        monitor.type = "http";
        monitor.url = "https://example.com";
        monitor.interval = 60;
        const monitorId = await R.store(monitor);

        // An old row, far outside a short retention window
        const oldTimestamp = dayjs().subtract(3650, "day").utc().startOf("month").unix();
        let oldStat = R.dispense("stat_monthly");
        oldStat.monitor_id = monitorId;
        oldStat.timestamp = oldTimestamp;
        oldStat.ping = 10;
        oldStat.ping_min = 5;
        oldStat.ping_max = 15;
        oldStat.up = 1;
        oldStat.down = 0;
        await R.store(oldStat);

        // A recent row that should survive
        const recentTimestamp = dayjs().utc().startOf("month").unix();
        let recentStat = R.dispense("stat_monthly");
        recentStat.monitor_id = monitorId;
        recentStat.timestamp = recentTimestamp;
        recentStat.ping = 20;
        recentStat.ping_min = 10;
        recentStat.ping_max = 30;
        recentStat.up = 1;
        recentStat.down = 0;
        await R.store(recentStat);

        // Use a short retention period so the "old" row above (10 years back) gets deleted,
        // but disable the unrelated heartbeat/stat_daily retention by setting a huge period for it
        // so this test does not depend on / interact with that pre-existing logic.
        await Settings.set("keepDataPeriodDays", 36500, "general");
        await Settings.set("keepMonthlyStatsPeriodDays", 30, "general");

        await clearOldData();

        let survivingRows = await R.find("stat_monthly", " monitor_id = ? ", [monitorId]);
        assert.strictEqual(survivingRows.length, 1, "only the recent stat_monthly row should survive");
        assert.strictEqual(survivingRows[0].timestamp, recentTimestamp);
    });

    test("keepMonthlyStatsPeriodDays < 1 disables stat_monthly deletion", async () => {
        let monitor = R.dispense("monitor");
        monitor.name = "Clear Old Data Monitor Disabled";
        monitor.type = "http";
        monitor.url = "https://example.com";
        monitor.interval = 60;
        const monitorId = await R.store(monitor);

        const veryOldTimestamp = dayjs().subtract(7300, "day").utc().startOf("month").unix();
        let veryOldStat = R.dispense("stat_monthly");
        veryOldStat.monitor_id = monitorId;
        veryOldStat.timestamp = veryOldTimestamp;
        veryOldStat.ping = 1;
        veryOldStat.ping_min = 1;
        veryOldStat.ping_max = 1;
        veryOldStat.up = 1;
        veryOldStat.down = 0;
        await R.store(veryOldStat);

        await Settings.set("keepDataPeriodDays", 36500, "general");
        await Settings.set("keepMonthlyStatsPeriodDays", 0, "general");

        await clearOldData();

        let survivingRows = await R.find("stat_monthly", " monitor_id = ? ", [monitorId]);
        assert.strictEqual(survivingRows.length, 1, "row should survive because deletion is disabled");
    });
});
