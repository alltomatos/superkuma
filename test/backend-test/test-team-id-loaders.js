process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { teamIdLoader, TABLE_BY_RESOURCE_TYPE } = require("../../server/security/team-id-loaders");

describe("team-id-loaders (resolves team_id from real tables)", () => {
    const testDb = new TestDB("./data/test-team-id-loaders");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("every allowlisted resource type maps to a table that actually has a team_id column", async () => {
        for (const [type, table] of Object.entries(TABLE_BY_RESOURCE_TYPE)) {
            assert.ok(
                await R.knex.schema.hasColumn(table, "team_id"),
                `${table} (resource type ${type}) should have team_id`
            );
        }
    });

    test("resolves the team_id of a real monitor row backfilled to the Default Team", async () => {
        const team = await R.knex("team").where("slug", "default").first();
        const bean = R.dispense("monitor");
        bean.name = "loader-test-monitor";
        bean.type = "http";
        bean.url = "https://example.com";
        bean.interval = 60;
        bean.team_id = team.id;
        const id = await R.store(bean);

        const resolved = await teamIdLoader("monitor", id);
        assert.strictEqual(resolved, team.id);
    });

    test("resolves the team_id of a real dashboard row", async () => {
        const team = await R.knex("team").where("slug", "default").first();
        const bean = R.dispense("dashboard");
        bean.team_id = team.id;
        bean.title = "loader-test-dashboard";
        const id = await R.store(bean);

        const resolved = await teamIdLoader("dashboard", id);
        assert.strictEqual(resolved, team.id);
    });

    test("returns null for a non-existent row", async () => {
        const resolved = await teamIdLoader("monitor", 999999);
        assert.strictEqual(resolved, null);
    });

    test("throws on an unknown resource type", async () => {
        await assert.rejects(teamIdLoader("not-a-real-type", 1), /No team_id loader for resource type/);
    });
});
