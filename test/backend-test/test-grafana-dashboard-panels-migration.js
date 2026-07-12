process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test } = require("node:test");
const assert = require("node:assert");
const knexLib = require("knex");
const migration = require("../../db/knex_migrations/2026-07-12-0001-add-grafana-dashboard-panels");

/**
 * Create a throwaway in-memory SQLite knex, molded on the other migration
 * tests' makeMemoryKnex(), for hermetic up/down round-trip checks of this
 * migration in isolation.
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
 * Build minimal ADR-0016 `dashboard`/`dashboard_widget` stubs (only the columns
 * this migration reads/adds onto), foreign keys off.
 * @param {object} knex The Knex instance to build the schema on.
 * @returns {Promise<void>}
 */
const buildStubSchema = async (knex) => {
    await knex.raw("PRAGMA foreign_keys = OFF");
    await knex.schema.createTable("dashboard", (t) => {
        t.increments("id");
        t.string("title", 255);
    });
    await knex.schema.createTable("dashboard_widget", (t) => {
        t.increments("id");
        t.integer("sort_order");
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

describe("Grafana dashboard panels migration — ADR-0017 (raw sqlite)", () => {
    test("up() adds the new dashboard and dashboard_widget columns", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);

            for (const col of ["slug", "published", "description", "refresh_interval", "theme"]) {
                assert.ok(await db.schema.hasColumn("dashboard", col), `dashboard.${col} should exist`);
            }
            for (const col of ["pos_x", "pos_y", "width", "height", "title", "config_json"]) {
                assert.ok(await db.schema.hasColumn("dashboard_widget", col), `dashboard_widget.${col} should exist`);
            }
        });
    });

    test("up() backfills a globally-unique slug from title + id", async () => {
        await withFreshDb(async (db) => {
            const [idA] = await db("dashboard").insert({ title: "My Fleet!" });
            const [idB] = await db("dashboard").insert({ title: "My Fleet!" }); // same title, different team

            await migration.up(db);

            const a = await db("dashboard").where("id", idA).first();
            const b = await db("dashboard").where("id", idB).first();
            assert.strictEqual(a.slug, `my-fleet-${idA}`);
            assert.strictEqual(b.slug, `my-fleet-${idB}`);
            assert.notStrictEqual(a.slug, b.slug, "same-titled dashboards must still get distinct slugs");
        });
    });

    test("up() gives an empty/symbol-only title a safe slug", async () => {
        await withFreshDb(async (db) => {
            const [id] = await db("dashboard").insert({ title: "!!!" });
            await migration.up(db);
            const row = await db("dashboard").where("id", id).first();
            assert.strictEqual(row.slug, `dashboard-${id}`);
        });
    });

    test("the slug UNIQUE index rejects a duplicate slug", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await db("dashboard").insert({ title: "x", slug: "dup", refresh_interval: 300, theme: "auto" });
            await assert.rejects(
                () => db("dashboard").insert({ title: "y", slug: "dup", refresh_interval: 300, theme: "auto" }),
                /UNIQUE|unique/i,
                "a duplicate slug must be rejected by the unique index"
            );
        });
    });

    test("published defaults to false", async () => {
        await withFreshDb(async (db) => {
            const [id] = await db("dashboard").insert({ title: "New" });
            await migration.up(db);
            const row = await db("dashboard").where("id", id).first();
            // SQLite stores booleans as 0/1
            assert.ok(!row.published, "published should default to false/0");
        });
    });

    test("up() stacks existing widgets by sort_order (pos_y = sort_order * 4)", async () => {
        await withFreshDb(async (db) => {
            const [w0] = await db("dashboard_widget").insert({ sort_order: 0 });
            const [w2] = await db("dashboard_widget").insert({ sort_order: 2 });

            await migration.up(db);

            assert.strictEqual((await db("dashboard_widget").where("id", w0).first()).pos_y, 0);
            assert.strictEqual((await db("dashboard_widget").where("id", w2).first()).pos_y, 8);
        });
    });

    test("up() is idempotent (a second run is a no-op, not an error)", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await assert.doesNotReject(() => migration.up(db), "re-running up() must not throw");
        });
    });

    test("down() removes exactly the columns up() added", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await migration.down(db);

            for (const col of ["slug", "published", "description", "refresh_interval", "theme"]) {
                assert.ok(!(await db.schema.hasColumn("dashboard", col)), `dashboard.${col} should be dropped`);
            }
            for (const col of ["pos_x", "pos_y", "width", "height", "title", "config_json"]) {
                assert.ok(
                    !(await db.schema.hasColumn("dashboard_widget", col)),
                    `dashboard_widget.${col} should be dropped`
                );
            }
        });
    });
});
