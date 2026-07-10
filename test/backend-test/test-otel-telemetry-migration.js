process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const knexLib = require("knex");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const migration = require("../../db/knex_migrations/2026-07-10-0002-add-otel-telemetry-receiver");

/**
 * Create a throwaway in-memory SQLite knex, molded on
 * test-alert-severity-migration.js's makeMemoryKnex(), for hermetic up/down
 * round-trip checks of this migration in isolation (independent of the rest
 * of the migration chain).
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
 * Build minimal id-only stubs of the "team" and "monitor" tables this
 * migration alters, with foreign keys disabled -- mirrors how SQLite runs
 * the real migration chain.
 * @param {object} knex The Knex instance to build the schema on.
 * @returns {Promise<void>}
 */
const buildStubSchema = async (knex) => {
    await knex.raw("PRAGMA foreign_keys = OFF");
    await knex.schema.createTable("team", (t) => t.increments("id"));
    await knex.schema.createTable("monitor", (t) => t.increments("id"));
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

describe("OTel telemetry receiver migration — structure (raw sqlite)", () => {
    test("adds team.otel_ingest_token and monitor.otel_* columns", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);

            assert.ok(await db.schema.hasColumn("team", "otel_ingest_token"), "team.otel_ingest_token should exist");
            for (const col of ["otel_metric_name", "otel_attribute_matchers", "otel_aggregation"]) {
                assert.ok(await db.schema.hasColumn("monitor", col), `monitor.${col} should exist`);
            }
        });
    });

    test("team.otel_ingest_token is NULL by default for pre-existing and freshly inserted teams (dark-launch)", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await db("team").insert({ id: 1 }); // simulates a pre-existing row untouched by the migration
            await db("team").insert({ id: 2 }); // simulates a team created after the migration ran

            const existing = await db("team").where("id", 1).first();
            const fresh = await db("team").where("id", 2).first();

            assert.strictEqual(existing.otel_ingest_token, null, "pre-existing team should have ingest disabled");
            assert.strictEqual(fresh.otel_ingest_token, null, "new team should have ingest disabled until opt-in");
        });
    });

    test("team.otel_ingest_token allows multiple NULLs despite the unique constraint (many dark teams coexist)", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await db("team").insert({ id: 1 });
            await db("team").insert({ id: 2 }); // must not violate the unique index -- both are NULL

            const count = await db("team").count("id as c").first();
            assert.strictEqual(Number(count.c), 2);
        });
    });

    test("monitor.otel_aggregation defaults to 'last'; otel_metric_name/otel_attribute_matchers default to NULL", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await db("monitor").insert({ id: 1 });
            const row = await db("monitor").where("id", 1).first();

            assert.strictEqual(row.otel_aggregation, "last");
            assert.strictEqual(row.otel_metric_name, null);
            assert.strictEqual(row.otel_attribute_matchers, null);
        });
    });

    test("is idempotent — re-running up() does not error or duplicate columns", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await migration.up(db); // second run must be a no-op, not throw

            assert.ok(await db.schema.hasColumn("team", "otel_ingest_token"));
            assert.ok(await db.schema.hasColumn("monitor", "otel_metric_name"));
            assert.ok(await db.schema.hasColumn("monitor", "otel_attribute_matchers"));
            assert.ok(await db.schema.hasColumn("monitor", "otel_aggregation"));
        });
    });

    test("up/down/up round-trips cleanly", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            assert.ok(await db.schema.hasColumn("team", "otel_ingest_token"));
            assert.ok(await db.schema.hasColumn("monitor", "otel_metric_name"));
            assert.ok(await db.schema.hasColumn("monitor", "otel_attribute_matchers"));
            assert.ok(await db.schema.hasColumn("monitor", "otel_aggregation"));

            await migration.down(db);
            assert.strictEqual(
                await db.schema.hasColumn("team", "otel_ingest_token"),
                false,
                "team.otel_ingest_token dropped"
            );
            for (const col of ["otel_metric_name", "otel_attribute_matchers", "otel_aggregation"]) {
                assert.strictEqual(await db.schema.hasColumn("monitor", col), false, `monitor.${col} dropped`);
            }

            await migration.up(db); // re-apply must succeed
            assert.ok(await db.schema.hasColumn("team", "otel_ingest_token"), "team.otel_ingest_token re-added");
            assert.ok(await db.schema.hasColumn("monitor", "otel_metric_name"), "monitor.otel_metric_name re-added");
            assert.ok(
                await db.schema.hasColumn("monitor", "otel_attribute_matchers"),
                "monitor.otel_attribute_matchers re-added"
            );
            assert.ok(await db.schema.hasColumn("monitor", "otel_aggregation"), "monitor.otel_aggregation re-added");
        });
    });
});

describe("OTel telemetry receiver migration — full pipeline (TestDB)", () => {
    const testDb = new TestDB("./data/test-otel-telemetry-migration");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("team.otel_ingest_token and monitor.otel_* columns exist after the real migration pipeline", async () => {
        assert.ok(await R.knex.schema.hasColumn("team", "otel_ingest_token"));
        for (const col of ["otel_metric_name", "otel_attribute_matchers", "otel_aggregation"]) {
            assert.ok(await R.knex.schema.hasColumn("monitor", col), `monitor.${col}`);
        }
    });

    test("the default team's otel_ingest_token is NULL (ingest disabled until an admin opts in)", async () => {
        const team = await R.knex("team").where("slug", "default").first();
        assert.ok(team, "default team should exist");
        assert.strictEqual(team.otel_ingest_token, null);
    });

    test("a monitor row can be created with type=otel + otel_* selectors and read back correctly", async () => {
        // Insert then re-query by a unique column, rather than trust the shape
        // of knex's insert() return value (it varies by driver/dialect) -- same
        // pattern used by test-alert-severity-migration.js and
        // test-anomaly-detection-migration.js.
        const matchers = JSON.stringify({ service: "payments" });
        await R.knex("monitor").insert({
            name: "otel-test-monitor",
            type: "otel",
            otel_metric_name: "http.server.request.duration",
            otel_attribute_matchers: matchers,
            otel_aggregation: "avg",
        });
        const monitor = await R.knex("monitor").where("name", "otel-test-monitor").first();

        assert.ok(monitor, "monitor row should exist");
        assert.strictEqual(monitor.type, "otel");
        assert.strictEqual(monitor.otel_metric_name, "http.server.request.duration");
        assert.strictEqual(monitor.otel_attribute_matchers, matchers);
        assert.deepStrictEqual(JSON.parse(monitor.otel_attribute_matchers), { service: "payments" });
        assert.strictEqual(monitor.otel_aggregation, "avg");
    });

    test("a monitor row created without specifying otel_aggregation defaults to 'last'", async () => {
        await R.knex("monitor").insert({ name: "otel-default-agg-monitor", type: "otel" });
        const monitor = await R.knex("monitor").where("name", "otel-default-agg-monitor").first();

        assert.ok(monitor, "monitor row should exist");
        assert.strictEqual(monitor.otel_aggregation, "last");
        assert.strictEqual(monitor.otel_metric_name, null);
        assert.strictEqual(monitor.otel_attribute_matchers, null);
    });
});
