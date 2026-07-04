process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const knexLib = require("knex");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { PERMISSIONS, BUILTIN_ROLES } = require("../../server/permissions/catalog");
const migration = require("../../db/knex_migrations/2026-07-04-0000-create-rbac-schema");

const RESOURCE_TABLES = [
    "monitor",
    "maintenance",
    "notification",
    "proxy",
    "docker_host",
    "api_key",
    "remote_browser",
    "remote_instance",
    "tag",
];

/**
 * Create a throwaway in-memory SQLite knex using the project's SQLite driver.
 * @returns {object} A Knex instance backed by a single in-memory connection.
 */
const makeMemoryKnex = () => {
    const Dialect = require("knex/lib/dialects/sqlite3/index.js");
    Dialect.prototype._driver = () => require("@louislam/sqlite3");
    return knexLib({
        client: Dialect,
        connection: { filename: ":memory:" },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 }, // keep the same in-memory connection alive
    });
};

/**
 * Build a minimal pre-migration schema (id-only stubs of the tables the
 * migration touches) with foreign keys disabled, mirroring how SQLite runs
 * migrations. `group` gets its real `public` column so we can prove it is left
 * untouched; `setting` gets the columns the flag insert needs.
 * @param {object} knex The Knex instance to build the schema on.
 * @returns {Promise<void>}
 */
const buildStubSchema = async (knex) => {
    await knex.raw("PRAGMA foreign_keys = OFF");
    await knex.schema.createTable("user", (t) => {
        t.increments("id");
        t.string("username");
    });
    for (const name of [...RESOURCE_TABLES, "status_page"]) {
        await knex.schema.createTable(name, (t) => t.increments("id"));
    }
    await knex.schema.createTable("group", (t) => {
        t.increments("id");
        t.boolean("public");
    });
    await knex.schema.createTable("setting", (t) => {
        t.increments("id");
        t.string("key");
        t.text("value");
        t.string("type");
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

// -------------------------------------------------------------------------
// Backfill + idempotency + round-trip, against minimal stubs (hermetic).
// -------------------------------------------------------------------------
describe("RBAC migration — backfill & structure (raw sqlite)", () => {
    test("creates every RBAC table and the resource team_id columns", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            for (const t of ["permission", "team", "role", "role_permission", "team_user", "audit_log"]) {
                assert.ok(await db.schema.hasTable(t), `${t} table should exist`);
            }
            for (const t of RESOURCE_TABLES) {
                assert.ok(await db.schema.hasColumn(t, "team_id"), `${t}.team_id should exist`);
            }
            assert.ok(await db.schema.hasColumn("status_page", "team_id"));
            assert.ok(await db.schema.hasColumn("status_page", "is_public"));
            assert.ok(await db.schema.hasColumn("api_key", "role_id"));
            for (const c of ["is_superadmin", "token_version", "must_change_password"]) {
                assert.ok(await db.schema.hasColumn("user", c), `user.${c} should exist`);
            }
            // `group` must NOT be altered (it inherits tenancy from status_page).
            assert.strictEqual(await db.schema.hasColumn("group", "team_id"), false, "group must not get team_id");
        });
    });

    test("seeds the full catalog and built-in roles from the single source of truth", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            const permCount = await db("permission").count("id as c").first();
            assert.strictEqual(Number(permCount.c), PERMISSIONS.length, "all permissions seeded");
            const roleCount = await db("role").count("id as c").first();
            assert.strictEqual(Number(roleCount.c), BUILTIN_ROLES.length, "all built-in roles seeded");
            const linkCount = await db("role_permission").count("role_id as c").first();
            assert.ok(Number(linkCount.c) > 0, "role_permission grants seeded");

            const superadmin = await db("role").whereNull("team_id").andWhere("slug", "superadmin").first();
            assert.ok(superadmin.is_superadmin, "superadmin role flagged");
        });
    });

    test("folds existing rows into a Default Team with correct memberships and flags", async () => {
        await withFreshDb(async (db) => {
            await db("user").insert([
                { id: 1, username: "admin" },
                { id: 2, username: "bob" },
            ]);
            await db("monitor").insert({ id: 1 });
            await db("api_key").insert({ id: 1 });

            await migration.up(db);

            const team = await db("team").where("slug", "default").first();
            assert.ok(team, "Default Team created");
            assert.ok(team.is_system, "Default Team is a system team");

            const monitor = await db("monitor").where("id", 1).first();
            assert.strictEqual(monitor.team_id, team.id, "monitor backfilled to Default Team");

            const viewer = await db("role").whereNull("team_id").andWhere("slug", "viewer").first();
            const apiKey = await db("api_key").where("id", 1).first();
            assert.strictEqual(apiKey.role_id, viewer.id, "legacy api key dropped to viewer");
            assert.strictEqual(apiKey.team_id, team.id, "api key joined the Default Team");

            const owner = await db("role").whereNull("team_id").andWhere("slug", "owner").first();
            const memberships = await db("team_user").where("team_id", team.id);
            assert.strictEqual(memberships.length, 2, "both users joined the Default Team");
            for (const m of memberships) {
                assert.strictEqual(m.role_id, owner.id, "existing users become owners");
            }

            const u1 = await db("user").where("id", 1).first();
            const u2 = await db("user").where("id", 2).first();
            assert.ok(u1.is_superadmin, "lowest-id user becomes super admin");
            assert.ok(!u2.is_superadmin, "other users are not super admin");

            const flag = await db("setting").where("key", "rbacEnforced").first();
            assert.strictEqual(flag.value, JSON.stringify(false), "dark-launch flag seeded OFF");
        });
    });

    test("is idempotent — re-running up() does not duplicate seeds or memberships", async () => {
        await withFreshDb(async (db) => {
            await db("user").insert({ id: 1, username: "admin" });
            await db("monitor").insert({ id: 1 });

            await migration.up(db);
            await migration.up(db); // second run must be a no-op

            const teams = await db("team").where("slug", "default");
            assert.strictEqual(teams.length, 1, "exactly one Default Team");
            const permCount = await db("permission").count("id as c").first();
            assert.strictEqual(Number(permCount.c), PERMISSIONS.length, "permissions not duplicated");
            const memberships = await db("team_user").where("user_id", 1);
            assert.strictEqual(memberships.length, 1, "membership not duplicated");
            const flags = await db("setting").where("key", "rbacEnforced");
            assert.strictEqual(flags.length, 1, "flag not duplicated");
        });
    });

    test("up/down/up round-trips cleanly", async () => {
        await withFreshDb(async (db) => {
            await migration.up(db);
            assert.ok(await db.schema.hasTable("team"));
            assert.ok(await db.schema.hasColumn("monitor", "team_id"));

            await migration.down(db);
            assert.strictEqual(await db.schema.hasTable("team"), false, "team dropped");
            assert.strictEqual(await db.schema.hasTable("role_permission"), false, "role_permission dropped");
            assert.strictEqual(await db.schema.hasColumn("monitor", "team_id"), false, "monitor.team_id dropped");
            assert.strictEqual(await db.schema.hasColumn("user", "is_superadmin"), false, "user.is_superadmin dropped");
            assert.strictEqual(
                await db.schema.hasColumn("status_page", "is_public"),
                false,
                "status_page.is_public dropped"
            );
            const flags = await db("setting").where("key", "rbacEnforced");
            assert.strictEqual(flags.length, 0, "flag removed on down()");

            await migration.up(db); // re-apply must succeed
            assert.ok(await db.schema.hasTable("team"), "team recreated on re-apply");
            assert.ok(await db.schema.hasColumn("monitor", "team_id"), "monitor.team_id re-added");
        });
    });
});

// -------------------------------------------------------------------------
// Full pipeline: the migration must run inside the real init_db + knex
// migrate.latest sequence against the real table schemas.
// -------------------------------------------------------------------------
describe("RBAC migration — full pipeline (TestDB)", () => {
    const testDb = new TestDB("./data/test-rbac-migration");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("all RBAC tables and columns exist after the real migration pipeline", async () => {
        for (const t of ["permission", "team", "role", "role_permission", "team_user", "audit_log"]) {
            assert.ok(await R.knex.schema.hasTable(t), `${t} should exist`);
        }
        for (const t of RESOURCE_TABLES) {
            assert.ok(await R.knex.schema.hasColumn(t, "team_id"), `${t}.team_id should exist`);
        }
        assert.ok(await R.knex.schema.hasColumn("status_page", "is_public"));
        assert.ok(await R.knex.schema.hasColumn("api_key", "role_id"));
        assert.strictEqual(await R.knex.schema.hasColumn("group", "team_id"), false, "group must not get team_id");
    });

    test("catalog is seeded and the Default Team + dark-launch flag exist", async () => {
        const permCount = await R.knex("permission").count("id as c").first();
        assert.strictEqual(Number(permCount.c), PERMISSIONS.length);

        const defaultTeam = await R.knex("team").where("slug", "default").first();
        assert.ok(defaultTeam, "Default Team created by backfill");

        const enforced = await Settings.get("rbacEnforced");
        assert.strictEqual(enforced, false, "enforcement defaults OFF (dark launch)");
    });
});
