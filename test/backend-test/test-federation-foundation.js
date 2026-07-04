process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const RemoteInstance = require("../../server/model/remote_instance");
const { Settings } = require("../../server/settings");

const testDb = new TestDB("./data/test-federation-foundation");

describe("Federation Foundation (F0 + M0)", () => {
    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("schema exists correctly", async () => {
        assert.ok(await R.knex.schema.hasTable("remote_instance"), "remote_instance table should exist");
        assert.ok(
            await R.knex.schema.hasColumn("monitor", "remote_instance_id"),
            "monitor.remote_instance_id column should exist"
        );
        assert.ok(await R.knex.schema.hasTable("stat_monthly"), "stat_monthly table should exist");
    });

    test("remote_instance.instance_id uniqueness is enforced", async () => {
        let bean = R.dispense("remote_instance");
        bean.instance_id = "unique-instance-1";
        bean.name = "Agent 1";
        bean.token_hash = "hashed-token-1";
        bean.active = true;
        await R.store(bean);

        let dup = R.dispense("remote_instance");
        dup.instance_id = "unique-instance-1";
        dup.name = "Agent 1 dupe";
        dup.token_hash = "hashed-token-2";
        dup.active = true;

        await assert.rejects(async () => {
            await R.store(dup);
        });
    });

    test("monitor.remote_instance_id is SET NULL (not CASCADE) when remote_instance is deleted", async () => {
        let remoteInstance = R.dispense("remote_instance");
        remoteInstance.instance_id = "set-null-instance";
        remoteInstance.name = "Agent SetNull";
        remoteInstance.token_hash = "hashed-token-setnull";
        remoteInstance.active = true;
        const remoteInstanceId = await R.store(remoteInstance);

        let monitor = R.dispense("monitor");
        monitor.name = "Mirrored Monitor";
        monitor.type = "http";
        monitor.url = "https://example.com";
        monitor.interval = 60;
        monitor.remote_instance_id = remoteInstanceId;
        const monitorId = await R.store(monitor);

        // Delete the remote_instance row
        await R.exec("DELETE FROM remote_instance WHERE id = ?", [remoteInstanceId]);

        // The monitor row must survive
        let survivedMonitor = await R.findOne("monitor", " id = ? ", [monitorId]);
        assert.ok(survivedMonitor, "monitor row should survive after remote_instance deletion");
        assert.strictEqual(
            survivedMonitor.remote_instance_id,
            null,
            "monitor.remote_instance_id should be NULL (SET NULL), not CASCADE-deleted"
        );
    });

    test("stat_monthly unique(monitor_id, timestamp) constraint is enforced", async () => {
        let monitor = R.dispense("monitor");
        monitor.name = "Stat Monthly Monitor";
        monitor.type = "http";
        monitor.url = "https://example.org";
        monitor.interval = 60;
        const monitorId = await R.store(monitor);

        let stat = R.dispense("stat_monthly");
        stat.monitor_id = monitorId;
        stat.timestamp = 1700000000;
        stat.ping = 10;
        stat.ping_min = 5;
        stat.ping_max = 15;
        stat.up = 1;
        stat.down = 0;
        await R.store(stat);

        let dupStat = R.dispense("stat_monthly");
        dupStat.monitor_id = monitorId;
        dupStat.timestamp = 1700000000;
        dupStat.ping = 20;
        dupStat.ping_min = 10;
        dupStat.ping_max = 30;
        dupStat.up = 1;
        dupStat.down = 0;

        await assert.rejects(async () => {
            await R.store(dupStat);
        });
    });

    test("RemoteInstance model toJSON() never exposes token_hash", async () => {
        let bean = R.dispense("remote_instance");
        bean.instance_id = "json-instance";
        bean.name = "Agent JSON";
        bean.token_hash = "super-secret-hash";
        bean.active = true;
        await R.store(bean);

        // R.dispense already returns a RemoteInstance instance because
        // Database.connect() autoloads ./server/model, mapping the
        // "remote_instance" bean type to the RemoteInstance class.
        assert.ok(bean instanceof RemoteInstance, "dispensed bean should be an instance of RemoteInstance");

        const json = bean.toJSON();
        assert.strictEqual(json.instanceId, "json-instance");
        assert.strictEqual(json.name, "Agent JSON");
        assert.strictEqual(json.active, true);
        assert.ok(!("token_hash" in json), "toJSON() must not include token_hash");
        assert.ok(!("tokenHash" in json), "toJSON() must not include tokenHash");
        assert.ok(
            !JSON.stringify(json).includes("super-secret-hash"),
            "serialized JSON must not leak the token hash value"
        );
    });

    test("migration rollback (down) and re-apply (up) round-trip cleanly", async () => {
        // Use a separate, throwaway knex/sqlite instance pointed at a raw file,
        // bypassing the full Database.patch() sequence, so we can invoke the
        // exported up/down functions of our two new migration files directly
        // without disturbing the shared testDb instance used by the other tests.
        const fs = require("fs");
        const knexLib = require("knex");

        const dbDir = path.join(__dirname, "../../data");
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        const rollbackDbPath = path.join(dbDir, "test-federation-rollback.db");
        if (fs.existsSync(rollbackDbPath)) {
            fs.unlinkSync(rollbackDbPath);
        }

        const Dialect = require("knex/lib/dialects/sqlite3/index.js");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");

        const rawKnex = knexLib({
            client: Dialect,
            connection: {
                filename: rollbackDbPath,
            },
            useNullAsDefault: true,
        });

        try {
            await rawKnex.raw("PRAGMA foreign_keys = OFF");

            // Minimal "monitor" table so our migrations (which alter/reference it)
            // have something to attach to, mirroring what a real DB would have.
            await rawKnex.schema.createTable("monitor", (table) => {
                table.increments("id");
            });

            const remoteInstanceMigration = require("../../db/knex_migrations/2026-07-03-0000-create-remote-instance");
            const statMonthlyMigration = require("../../db/knex_migrations/2026-07-03-0001-create-stat-monthly");

            // Apply both migrations (up)
            await remoteInstanceMigration.up(rawKnex);
            await statMonthlyMigration.up(rawKnex);

            assert.ok(await rawKnex.schema.hasTable("remote_instance"));
            assert.ok(await rawKnex.schema.hasColumn("monitor", "remote_instance_id"));
            assert.ok(await rawKnex.schema.hasTable("stat_monthly"));

            // Roll back both migrations (down), in reverse order of application
            await statMonthlyMigration.down(rawKnex);
            await remoteInstanceMigration.down(rawKnex);

            assert.strictEqual(await rawKnex.schema.hasTable("stat_monthly"), false, "stat_monthly should be dropped");
            assert.strictEqual(
                await rawKnex.schema.hasTable("remote_instance"),
                false,
                "remote_instance should be dropped"
            );
            assert.strictEqual(
                await rawKnex.schema.hasColumn("monitor", "remote_instance_id"),
                false,
                "monitor.remote_instance_id should be dropped"
            );

            // Re-apply (up) again -- round-trip must be clean
            await remoteInstanceMigration.up(rawKnex);
            await statMonthlyMigration.up(rawKnex);

            assert.ok(
                await rawKnex.schema.hasTable("remote_instance"),
                "remote_instance should exist again after re-apply"
            );
            assert.ok(
                await rawKnex.schema.hasColumn("monitor", "remote_instance_id"),
                "monitor.remote_instance_id should exist again after re-apply"
            );
            assert.ok(await rawKnex.schema.hasTable("stat_monthly"), "stat_monthly should exist again after re-apply");
        } finally {
            await rawKnex.destroy();
            if (fs.existsSync(rollbackDbPath)) {
                fs.unlinkSync(rollbackDbPath);
            }
        }
    });
});
