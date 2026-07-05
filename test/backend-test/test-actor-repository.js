process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const knexLib = require("knex");
const jwt = require("jsonwebtoken");
const { R } = require("redbean-node");
const migration = require("../../db/knex_migrations/2026-07-04-0000-create-rbac-schema");
const {
    buildActorForUser,
    buildActorForApiKey,
    buildPermissionPayload,
} = require("../../server/security/actor-repository");
const User = require("../../server/model/user");

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
 * Build a stubbed schema + seed two users, then run the RBAC migration so the
 * backfill wires memberships (user 1 -> superadmin + owner, user 2 -> owner).
 * @param {object} db The Knex instance.
 * @returns {Promise<void>}
 */
const seed = async (db) => {
    await db.raw("PRAGMA foreign_keys = OFF");
    await db.schema.createTable("user", (t) => {
        t.increments("id");
        t.string("username");
    });
    for (const name of [...RESOURCE_TABLES, "status_page"]) {
        await db.schema.createTable(name, (t) => t.increments("id"));
    }
    await db.schema.createTable("group", (t) => {
        t.increments("id");
        t.boolean("public");
    });
    await db.schema.createTable("setting", (t) => {
        t.increments("id");
        t.string("key");
        t.text("value");
        t.string("type");
    });
    await db("user").insert([
        { id: 1, username: "admin" },
        { id: 2, username: "bob" },
    ]);
    await db("api_key").insert({ id: 1 });
    await migration.up(db);
};

describe("actor-repository (builds actors from the DB)", () => {
    let db;

    before(async () => {
        const Dialect = require("knex/lib/dialects/sqlite3/index.js");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");
        db = knexLib({
            client: Dialect,
            connection: { filename: ":memory:" },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
        });
        R.setup(db);
        await seed(db);
    });

    after(async () => {
        await db.destroy();
    });

    test("super-admin user gets isSuperadmin and full owner permissions", async () => {
        const u1 = await db("user").where("id", 1).first();
        const actor = await buildActorForUser(u1);
        const team = await db("team").where("slug", "default").first();

        assert.strictEqual(actor.isSuperadmin, true);
        assert.strictEqual(actor.userId, 1);
        assert.ok(actor.memberships.has(team.id), "member of the Default Team");
        const perms = actor.memberships.get(team.id).permissions;
        assert.ok(perms.has("monitor:create"), "owner can create monitors");
        assert.ok(perms.has("team:manage"), "owner can manage the team");
        assert.strictEqual(actor.memberships.get(team.id).roleSlug, "owner");
    });

    test("regular user is owner of the Default Team but not superadmin", async () => {
        const u2 = await db("user").where("id", 2).first();
        const actor = await buildActorForUser(u2);
        const team = await db("team").where("slug", "default").first();

        assert.strictEqual(actor.isSuperadmin, false);
        assert.ok(actor.memberships.get(team.id).permissions.has("monitor:create"));
    });

    test("permission payload carries currentUser, team name and role", async () => {
        const u1 = await db("user").where("id", 1).first();
        const actor = await buildActorForUser(u1);
        const payload = await buildPermissionPayload(u1, actor);

        assert.strictEqual(payload.currentUser.username, "admin");
        assert.strictEqual(payload.currentUser.isSuperadmin, true);
        assert.strictEqual(payload.teams.length, 1);
        assert.strictEqual(payload.teams[0].name, "Default Team");
        assert.strictEqual(payload.teams[0].role, "owner");
        assert.ok(payload.teams[0].permissions.includes("monitor:create"));
    });

    test("API-key actor is capped to the viewer role and never inherits superadmin", async () => {
        const key = await db("api_key").where("id", 1).first();
        // Backfill dropped the legacy key to the viewer role of the Default Team.
        const actor = await buildActorForApiKey(key);

        assert.strictEqual(actor.isSuperadmin, false, "api key never superadmin");
        const perms = actor.memberships.get(key.team_id).permissions;
        assert.ok(perms.has("monitor:read"), "viewer can read");
        assert.ok(!perms.has("monitor:create"), "viewer cannot create");
    });
});

describe("User.createJWT claims", () => {
    test("includes sub + tv + h and no expiry by default", () => {
        const token = User.createJWT({ id: 5, username: "x", password: "pw", token_version: 3 }, "secret");
        const decoded = jwt.decode(token);
        assert.strictEqual(decoded.sub, "5");
        assert.strictEqual(decoded.tv, 3);
        assert.strictEqual(decoded.username, "x");
        assert.ok(decoded.h, "password hash claim present");
        assert.strictEqual(decoded.exp, undefined, "no expiry by default");
    });

    test("adds an expiry when a positive lifetime is given", () => {
        const token = User.createJWT({ id: 1, username: "x", password: "pw" }, "secret", 3600);
        const decoded = jwt.decode(token);
        assert.ok(decoded.exp, "exp set");
        assert.ok(decoded.iat, "iat set");
        assert.strictEqual(decoded.exp - decoded.iat, 3600, "expiry matches the given lifetime");
        assert.strictEqual(decoded.tv, 0, "missing token_version defaults to 0");
    });
});
