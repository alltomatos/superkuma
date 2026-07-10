process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const knexLib = require("knex");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const migration = require("../../db/knex_migrations/2026-07-10-0001-add-anomaly-detection");

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
 * Build a minimal id-only stub of the "monitor" table this migration
 * references via FK, with foreign keys disabled -- mirrors how SQLite runs
 * the real migration chain.
 * @param {object} knex The Knex instance to build the schema on.
 * @returns {Promise<void>}
 */
const buildStubSchema = async (knex) => {
    await knex.raw("PRAGMA foreign_keys = OFF");
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

describe("Anomaly detection migration — structure (raw sqlite)", () => {
    test("adds anomaly_* columns to monitor and creates alert_event", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);

            for (const col of [
                "anomaly_enabled",
                "anomaly_metric",
                "anomaly_window",
                "anomaly_z_threshold",
                "anomaly_seasonality",
                "anomaly_direction",
                "anomaly_severity",
            ]) {
                assert.ok(await db.schema.hasColumn("monitor", col), `monitor.${col} should exist`);
            }

            assert.ok(await db.schema.hasTable("alert_event"), "alert_event table should exist");
            for (const col of ["id", "monitor_id", "type", "value", "expected", "score", "severity", "time"]) {
                assert.ok(await db.schema.hasColumn("alert_event", col), `alert_event.${col}`);
            }
        });
    });

    test("monitor anomaly_* columns default to dark-by-construction values for a freshly inserted row", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await db("monitor").insert({ id: 1 });
            const row = await db("monitor").where("id", 1).first();

            assert.strictEqual(!!row.anomaly_enabled, false);
            assert.strictEqual(row.anomaly_metric, "response_time");
            assert.strictEqual(row.anomaly_window, 20);
            assert.strictEqual(Number(row.anomaly_z_threshold), 3.0);
            assert.strictEqual(row.anomaly_seasonality, "none");
            assert.strictEqual(row.anomaly_direction, "both");
            assert.strictEqual(row.anomaly_severity, "warning");
        });
    });

    test("alert_event starts empty on every install (no rows created by this migration)", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            const count = await db("alert_event").count("id as c").first();
            assert.strictEqual(Number(count.c), 0);
        });
    });

    test("is idempotent — re-running up() does not error or duplicate columns/table", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            await migration.up(db); // second run must be a no-op, not throw

            assert.ok(await db.schema.hasColumn("monitor", "anomaly_enabled"));
            assert.ok(await db.schema.hasTable("alert_event"));
        });
    });

    test("up/down/up round-trips cleanly", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            assert.ok(await db.schema.hasTable("alert_event"));
            assert.ok(await db.schema.hasColumn("monitor", "anomaly_enabled"));

            await migration.down(db);
            assert.strictEqual(await db.schema.hasTable("alert_event"), false, "alert_event dropped");
            for (const col of [
                "anomaly_enabled",
                "anomaly_metric",
                "anomaly_window",
                "anomaly_z_threshold",
                "anomaly_seasonality",
                "anomaly_direction",
                "anomaly_severity",
            ]) {
                assert.strictEqual(await db.schema.hasColumn("monitor", col), false, `monitor.${col} dropped`);
            }

            await migration.up(db); // re-apply must succeed
            assert.ok(await db.schema.hasTable("alert_event"), "alert_event recreated");
            assert.ok(await db.schema.hasColumn("monitor", "anomaly_enabled"), "monitor.anomaly_enabled re-added");
        });
    });
});

describe("Anomaly detection migration — full pipeline (TestDB)", () => {
    const testDb = new TestDB("./data/test-anomaly-detection-migration");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("monitor anomaly_* columns and alert_event exist after the real migration pipeline", async () => {
        for (const col of [
            "anomaly_enabled",
            "anomaly_metric",
            "anomaly_window",
            "anomaly_z_threshold",
            "anomaly_seasonality",
            "anomaly_direction",
            "anomaly_severity",
        ]) {
            assert.ok(await R.knex.schema.hasColumn("monitor", col), `monitor.${col}`);
        }
        assert.ok(await R.knex.schema.hasTable("alert_event"));
    });

    test("an alert_event row can reference a real monitor and be read back", async () => {
        // Insert then re-query by a unique column, rather than trust the shape
        // of knex's insert() return value (it varies by driver/dialect) -- same
        // pattern used by test-alert-severity-migration.js.
        await R.knex("monitor").insert({ name: "anomaly-test-monitor", type: "http" });
        const monitorId = (await R.knex("monitor").where("name", "anomaly-test-monitor").first()).id;

        await R.knex("alert_event").insert({
            monitor_id: monitorId,
            type: "anomaly",
            value: 850.5,
            expected: 200.0,
            score: 4.2,
            severity: "warning",
        });
        const event = await R.knex("alert_event").where("monitor_id", monitorId).first();

        assert.ok(event, "alert_event row should exist");
        assert.strictEqual(event.monitor_id, monitorId);
        assert.strictEqual(event.type, "anomaly");
        assert.strictEqual(Number(event.value), 850.5);
        assert.strictEqual(Number(event.expected), 200.0);
        assert.strictEqual(Number(event.score), 4.2);
        assert.strictEqual(event.severity, "warning");
        assert.ok(event.time, "time should be set by the column default");
    });
});
