process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const knexLib = require("knex");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const migration = require("../../db/knex_migrations/2026-07-10-0000-add-alert-severity-and-notification-routing");

/**
 * Create a throwaway in-memory SQLite knex, molded on test-rbac-migration.js's
 * makeMemoryKnex(), for hermetic up/down round-trip checks of this migration
 * in isolation (independent of the rest of the migration chain).
 * @returns {object} A Knex instance backed by a single in-memory connection.
 */
const makeMemoryKnex = () => {
    const Dialect = require("knex/lib/dialects/sqlite3/index.js");
    Dialect.prototype._driver = () => require("@louislam/sqlite3");
    return knexLib({
        client: Dialect,
        connection: { filename: ":memory:" },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
    });
};

/**
 * Build minimal id-only stubs of the tables this migration references via FK
 * (team/monitor/tag/notification), with foreign keys disabled -- mirrors how
 * SQLite runs the real migration chain.
 * @param {object} knex The Knex instance to build the schema on.
 * @returns {Promise<void>}
 */
const buildStubSchema = async (knex) => {
    await knex.raw("PRAGMA foreign_keys = OFF");
    await knex.schema.createTable("monitor", (t) => t.increments("id"));
    await knex.schema.createTable("team", (t) => t.increments("id"));
    await knex.schema.createTable("tag", (t) => t.increments("id"));
    await knex.schema.createTable("notification", (t) => t.increments("id"));
};

/**
 * Run a callback against a fresh, stubbed, in-memory database.
 * @param {Function} fn Async callback receiving the Knex instance.
 * @returns {Promise<void>}
 */
const withFreshDb = async (fn) => {
    const db = makeMemoryKnex();
    try {
        await buildStubSchema(db);
        await fn(db);
    } finally {
        await db.destroy();
    }
};

describe("Alert severity + notification routing migration — structure (raw sqlite)", () => {
    test("adds monitor.alert_severity and creates notification_route", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);

            assert.ok(await db.schema.hasColumn("monitor", "alert_severity"), "monitor.alert_severity should exist");
            assert.ok(await db.schema.hasTable("notification_route"), "notification_route table should exist");
            for (const col of ["team_id", "min_severity", "monitor_id", "tag_id", "notification_id"]) {
                assert.ok(await db.schema.hasColumn("notification_route", col), `notification_route.${col}`);
            }
        });
    });

    test("monitor.alert_severity defaults to 'critical' for a freshly inserted row (dark by construction)", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await db("monitor").insert({ id: 1 });
            const row = await db("monitor").where("id", 1).first();
            assert.strictEqual(row.alert_severity, "critical");
        });
    });

    test("notification_route starts empty on every install (no rows created by this migration)", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            const count = await db("notification_route").count("id as c").first();
            assert.strictEqual(Number(count.c), 0);
        });
    });

    test("is idempotent — re-running up() does not error or duplicate the column/table", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await migration.up(db); // second run must be a no-op, not throw
            assert.ok(await db.schema.hasColumn("monitor", "alert_severity"));
            assert.ok(await db.schema.hasTable("notification_route"));
        });
    });

    test("up/down/up round-trips cleanly", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            assert.ok(await db.schema.hasTable("notification_route"));
            assert.ok(await db.schema.hasColumn("monitor", "alert_severity"));

            await migration.down(db);
            assert.strictEqual(await db.schema.hasTable("notification_route"), false, "notification_route dropped");
            assert.strictEqual(
                await db.schema.hasColumn("monitor", "alert_severity"),
                false,
                "monitor.alert_severity dropped"
            );

            await migration.up(db); // re-apply must succeed
            assert.ok(await db.schema.hasTable("notification_route"), "notification_route recreated");
            assert.ok(await db.schema.hasColumn("monitor", "alert_severity"), "monitor.alert_severity re-added");
        });
    });
});

describe("Alert severity + notification routing migration — full pipeline (TestDB)", () => {
    const testDb = new TestDB("./data/test-alert-severity-migration");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("monitor.alert_severity and notification_route exist after the real migration pipeline", async () => {
        assert.ok(await R.knex.schema.hasColumn("monitor", "alert_severity"));
        assert.ok(await R.knex.schema.hasTable("notification_route"));
    });

    test("a notification_route row can reference team/monitor/tag/notification together", async () => {
        // Insert then re-query by a unique column, rather than trust the shape of
        // knex's insert() return value (it varies by driver/dialect) -- same
        // pattern already used by the RBAC migration's own test fixtures.
        await R.knex("user").insert({ username: "route-test-owner", password: "x" });
        const userId = (await R.knex("user").where("username", "route-test-owner").first()).id;

        await R.knex("monitor").insert({ name: "route-test-monitor", type: "http" });
        const monitorId = (await R.knex("monitor").where("name", "route-test-monitor").first()).id;

        await R.knex("notification").insert({
            name: "route-test-notif",
            config: JSON.stringify({ name: "route-test-notif", type: "webhook" }),
            user_id: userId,
        });
        const notifId = (await R.knex("notification").where("name", "route-test-notif").first()).id;

        await R.knex("tag").insert({ name: "route-test-tag", color: "#000000" });
        const tagId = (await R.knex("tag").where("name", "route-test-tag").first()).id;

        const team = await R.knex("team").where("slug", "default").first();

        await R.knex("notification_route").insert({
            team_id: team.id,
            min_severity: "warning",
            monitor_id: monitorId,
            tag_id: tagId,
            notification_id: notifId,
        });
        const route = await R.knex("notification_route").where("notification_id", notifId).first();

        assert.ok(route, "notification_route row should exist");
        assert.strictEqual(route.team_id, team.id);
        assert.strictEqual(route.min_severity, "warning");
        assert.strictEqual(route.monitor_id, monitorId);
        assert.strictEqual(route.tag_id, tagId);
    });
});
