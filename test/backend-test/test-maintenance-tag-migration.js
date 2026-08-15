process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const knexLib = require("knex");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const migration = require("../../db/knex_migrations/2026-08-15-0001-add-maintenance-tag");

/**
 * Create a throwaway in-memory SQLite knex, molded on
 * test-alert-severity-migration.js's makeMemoryKnex(), for hermetic up/down
 * round-trip checks of this migration in isolation.
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
 * (maintenance/tag), with foreign keys disabled.
 * @param {object} knex The Knex instance to build the schema on.
 * @returns {Promise<void>}
 */
const buildStubSchema = async (knex) => {
    await knex.raw("PRAGMA foreign_keys = OFF");
    await knex.schema.createTable("maintenance", (t) => t.increments("id"));
    await knex.schema.createTable("tag", (t) => t.increments("id"));
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

describe("Maintenance tag migration — structure (raw sqlite)", () => {
    test("creates maintenance_tag with the expected columns", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);

            assert.ok(await db.schema.hasTable("maintenance_tag"), "maintenance_tag table should exist");
            for (const col of ["maintenance_id", "tag_id"]) {
                assert.ok(await db.schema.hasColumn("maintenance_tag", col), `maintenance_tag.${col}`);
            }
        });
    });

    test("starts empty on every install (no rows created by this migration)", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            const count = await db("maintenance_tag").count("id as c").first();
            assert.strictEqual(Number(count.c), 0);
        });
    });

    test("is idempotent — re-running up() does not error or duplicate the table", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await migration.up(db);
            assert.ok(await db.schema.hasTable("maintenance_tag"));
        });
    });

    test("up/down/up round-trips cleanly", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            assert.ok(await db.schema.hasTable("maintenance_tag"));

            await migration.down(db);
            assert.strictEqual(await db.schema.hasTable("maintenance_tag"), false, "maintenance_tag dropped");

            await migration.up(db);
            assert.ok(await db.schema.hasTable("maintenance_tag"), "maintenance_tag recreated");
        });
    });
});

describe("Maintenance tag migration — full pipeline (TestDB)", () => {
    const testDb = new TestDB("./data/test-maintenance-tag-migration");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("maintenance_tag exists after the real migration pipeline", async () => {
        assert.ok(await R.knex.schema.hasTable("maintenance_tag"));
    });

    test("a maintenance_tag row can reference a real maintenance and tag together", async () => {
        await R.knex("maintenance").insert({ title: "mt-migration-test", description: "" });
        const maintenanceId = (await R.knex("maintenance").where("title", "mt-migration-test").first()).id;

        await R.knex("tag").insert({ name: "mt-migration-tag", color: "#000000" });
        const tagId = (await R.knex("tag").where("name", "mt-migration-tag").first()).id;

        await R.knex("maintenance_tag").insert({ maintenance_id: maintenanceId, tag_id: tagId });
        const row = await R.knex("maintenance_tag").where("maintenance_id", maintenanceId).first();

        assert.ok(row, "maintenance_tag row should exist");
        assert.strictEqual(row.tag_id, tagId);
    });
});
