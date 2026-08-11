process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test } = require("node:test");
const assert = require("node:assert");
const knexLib = require("knex");
const migration = require("../../db/knex_migrations/2026-08-11-0001-rename-radius-password-to-password");

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
 * Build a minimal stand-in of the monitor table with only the column this
 * migration touches, mirroring how the real chain runs on top of
 * db/knex_init_db.js's baseline schema.
 * @param {object} knex The Knex instance to build the schema on.
 * @returns {Promise<void>}
 */
const buildStubSchema = async (knex) => {
    await knex.schema.createTable("monitor", (t) => {
        t.increments("id");
        t.string("radius_password", 255);
    });
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

describe("Rename radius_password to password migration", () => {
    test("up() renames radius_password to password", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);

            assert.ok(await db.schema.hasColumn("monitor", "password"), "monitor.password should exist");
            assert.ok(
                !(await db.schema.hasColumn("monitor", "radius_password")),
                "monitor.radius_password should no longer exist"
            );
        });
    });

    test("up() preserves existing data across the rename", async () => {
        await withFreshDb(async (db) => {
            await db("monitor").insert({ radius_password: "super-secret" });

            await migration.up(db);

            const row = await db("monitor").first();
            assert.strictEqual(row.password, "super-secret");
        });
    });

    test("down() reverts password back to radius_password", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await migration.down(db);

            assert.ok(await db.schema.hasColumn("monitor", "radius_password"), "monitor.radius_password should exist");
            assert.ok(
                !(await db.schema.hasColumn("monitor", "password")),
                "monitor.password should no longer exist"
            );
        });
    });

    test("up/down/up round-trips cleanly", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await migration.down(db);
            await migration.up(db);

            assert.ok(await db.schema.hasColumn("monitor", "password"));
        });
    });
});
