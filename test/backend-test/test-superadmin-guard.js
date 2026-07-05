process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { hasActiveSuperadmin } = require("../../server/security/actor-repository");

describe("hasActiveSuperadmin (ADR-0010 P4 last-superadmin guard)", () => {
    const testDb = new TestDB("./data/test-superadmin-guard");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    /**
     * Insert a user row with the given superadmin/active flags.
     * @param {string} username Unique username for the row
     * @param {boolean} isSuperadmin Value for is_superadmin
     * @param {boolean} active Value for active
     * @returns {Promise<number>} The inserted user id
     */
    async function seedUser(username, isSuperadmin, active) {
        const bean = R.dispense("user");
        bean.username = username;
        bean.password = "x";
        bean.is_superadmin = isSuperadmin;
        bean.active = active;
        return R.store(bean);
    }

    test("a fresh database with no users at all fails the guard (fails closed)", async () => {
        assert.strictEqual(await hasActiveSuperadmin(), false);
    });

    test("returns true when an active superadmin exists among other users", async () => {
        await seedUser("guard-viewer-1", false, true);
        await seedUser("guard-superadmin-1", true, true);
        assert.strictEqual(await hasActiveSuperadmin(), true);
    });

    test("returns false when the only superadmin is deactivated", async () => {
        await R.exec("UPDATE user SET active = 0 WHERE is_superadmin = 1");
        try {
            assert.strictEqual(await hasActiveSuperadmin(), false);
        } finally {
            await R.exec("UPDATE user SET active = 1 WHERE is_superadmin = 1");
        }
    });

    test("returns false when no user is flagged as superadmin at all", async () => {
        await R.exec("UPDATE user SET is_superadmin = 0");
        try {
            assert.strictEqual(await hasActiveSuperadmin(), false);
        } finally {
            // Restore the original migration-backfilled superadmin (lowest id).
            const firstUser = await R.getRow("SELECT id FROM user ORDER BY id ASC LIMIT 1");
            await R.exec("UPDATE user SET is_superadmin = 1 WHERE id = ?", [firstUser.id]);
        }
    });

    test("many active non-superadmin users don't satisfy the guard on their own", async () => {
        await R.exec("UPDATE user SET is_superadmin = 0");
        try {
            await seedUser("guard-viewer-2", false, true);
            await seedUser("guard-viewer-3", false, true);
            assert.strictEqual(await hasActiveSuperadmin(), false);
        } finally {
            const firstUser = await R.getRow("SELECT id FROM user ORDER BY id ASC LIMIT 1");
            await R.exec("UPDATE user SET is_superadmin = 1 WHERE id = ?", [firstUser.id]);
        }
    });
});
