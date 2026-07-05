process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");

// server.js normally registers these dayjs plugins once at boot. This test
// requires superkuma-server.js's initAfterDatabaseReady() directly, which
// itself sets dayjs.tz's default timezone -- register the same plugins first
// so that call doesn't blow up, matching other standalone tests in this suite.
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { setEnforcementEnabled, isEnforcementEnabled } = require("../../server/security/authz");
const { SuperKumaServer } = require("../../server/superkuma-server");

describe("rbacEnforced boot-time sync (ADR-0010 P4)", () => {
    const testDb = new TestDB("./data/test-rbac-boot-sync");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        setEnforcementEnabled(false);
        await testDb.destroy();
    });

    test("no 'rbacEnforced' row yet (fresh install): initAfterDatabaseReady() leaves enforcement OFF", async () => {
        setEnforcementEnabled(true); // start from the opposite state to prove this isn't a no-op read
        const server = SuperKumaServer.getInstance();
        await server.initAfterDatabaseReady();
        assert.strictEqual(isEnforcementEnabled(), false);
    });

    test("'rbacEnforced' persisted as true: initAfterDatabaseReady() turns enforcement ON", async () => {
        await Settings.set("rbacEnforced", true);
        try {
            const server = SuperKumaServer.getInstance();
            await server.initAfterDatabaseReady();
            assert.strictEqual(isEnforcementEnabled(), true);
        } finally {
            await Settings.set("rbacEnforced", false);
        }
    });

    test("'rbacEnforced' persisted as false: initAfterDatabaseReady() leaves/turns enforcement OFF", async () => {
        setEnforcementEnabled(true); // start from the opposite state to prove this isn't a no-op read
        await Settings.set("rbacEnforced", false);
        const server = SuperKumaServer.getInstance();
        await server.initAfterDatabaseReady();
        assert.strictEqual(isEnforcementEnabled(), false);
    });
});
