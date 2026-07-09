process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const knexLib = require("knex");
const { R } = require("redbean-node");
const migration = require("../../db/knex_migrations/2026-07-04-0000-create-rbac-schema");
const { Proxy } = require("../../server/proxy");
const { buildActor, ForbiddenError } = require("../../server/security/authz");

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
 * Build a stubbed schema with a single user, then run the real RBAC migration
 * so the backfill wires the Default Team + owner role for that user.
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
        await db.schema.createTable(name, (t) => {
            t.increments("id");
            t.integer("user_id");
            if (name === "monitor") {
                t.integer("proxy_id");
            }
        });
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
    await db("user").insert([{ id: 1, username: "admin" }]);
    await db("api_key").insert({ id: 1 });
    await migration.up(db);
};

describe("Proxy authz retrofit (ADR-0010)", () => {
    let db;
    let defaultTeamId;
    let otherTeamId;
    let proxyInOtherTeamId;

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

        const defaultTeam = await db("team").where("slug", "default").first();
        defaultTeamId = defaultTeam.id;

        // A second, unrelated team that our test actor is NOT a member of.
        [otherTeamId] = await db("team").insert({
            name: "Other Team",
            slug: "other",
            is_system: false,
            active: true,
        });

        // A proxy owned by the OTHER team (simulating another tenant's resource),
        // still nominally attached to user_id=1 in the legacy column so the
        // pre-existing ownership check would (today) still find it -- this is
        // exactly the scenario requireResource must catch once enforcement is ON.
        const otherBean = R.dispense("proxy");
        otherBean.user_id = 1;
        otherBean.protocol = "http";
        otherBean.host = "other-team.example.com";
        otherBean.port = 8081;
        otherBean.team_id = otherTeamId;
        proxyInOtherTeamId = await R.store(otherBean);
    });

    after(async () => {
        await db.destroy();
    });

    describe("actor has no access", () => {
        test("Proxy.save (update) with actor null/undefined is denied -- no actor-optional escape hatch", async () => {
            await assert.rejects(
                Proxy.save({ protocol: "https", host: "updated.example.com", port: 9090 }, proxyInOtherTeamId, 1, null),
                ForbiddenError
            );
        });

        test("Proxy.save (create) with actor null/undefined is denied -- no actor-optional escape hatch", async () => {
            await assert.rejects(
                Proxy.save({ protocol: "http", host: "new.example.com", port: 1234 }, null, 1, null),
                ForbiddenError
            );
        });

        test("Proxy.delete with actor null/undefined is denied -- no actor-optional escape hatch", async () => {
            const bean = R.dispense("proxy");
            bean.user_id = 1;
            bean.protocol = "http";
            bean.host = "to-delete.example.com";
            bean.port = 3000;
            bean.team_id = defaultTeamId;
            const id = await R.store(bean);

            await assert.rejects(Proxy.delete(id, 1, null), ForbiddenError);

            const found = await R.findOne("proxy", " id = ? ", [id]);
            assert.ok(found, "proxy must survive a denied delete");
        });

        test("Proxy.save denies a foreign actor before ever reaching the legacy 'not found' check", async () => {
            const outsider = buildActor({ userId: 1, isSuperadmin: false }, [
                { teamId: defaultTeamId, roleSlug: "owner" },
            ]);
            await assert.rejects(
                Proxy.save({ protocol: "http", host: "x", port: 80 }, proxyInOtherTeamId, 999, outsider),
                ForbiddenError
            );
        });
    });

    describe("real cross-team denial through the actual save()/delete() methods", () => {
        test("Proxy.save with a valid team but wrong userID in the WHERE clause still fails with 'proxy not found' (legacy check preserved as defense-in-depth)", async () => {
            const member = buildActor({ userId: 1, isSuperadmin: false }, [{ teamId: otherTeamId, roleSlug: "owner" }]);
            await assert.rejects(
                Proxy.save({ protocol: "http", host: "x", port: 80 }, proxyInOtherTeamId, 999, member),
                /proxy not found/
            );
        });

        test("actor with no membership in the resource's team is denied on save", async () => {
            const outsider = buildActor({ userId: 1, isSuperadmin: false }, [
                { teamId: defaultTeamId, roleSlug: "owner" },
            ]);

            await assert.rejects(
                Proxy.save(
                    { protocol: "http", host: "should-not-update.example.com", port: 80 },
                    proxyInOtherTeamId,
                    1,
                    outsider
                ),
                ForbiddenError
            );
        });

        test("actor with no membership in the resource's team is denied on delete", async () => {
            const outsider = buildActor({ userId: 1, isSuperadmin: false }, [
                { teamId: defaultTeamId, roleSlug: "owner" },
            ]);

            await assert.rejects(Proxy.delete(proxyInOtherTeamId, 1, outsider), ForbiddenError);

            // Still present -- the legacy delete never ran because requireResource
            // threw before the existing "id = ? AND user_id = ?" lookup.
            const stillThere = await R.findOne("proxy", " id = ? ", [proxyInOtherTeamId]);
            assert.ok(stillThere, "proxy must survive a denied delete");
        });

        test("actor who IS a member of the owning team, with proxy:manage, is allowed", async () => {
            const member = buildActor({ userId: 1, isSuperadmin: false }, [{ teamId: otherTeamId, roleSlug: "owner" }]);

            const bean = await Proxy.save(
                { protocol: "https", host: "authorized-update.example.com", port: 443 },
                proxyInOtherTeamId,
                1,
                member
            );
            assert.strictEqual(bean.host, "authorized-update.example.com");
        });

        test("a viewer (lacking proxy:manage) in the owning team is denied", async () => {
            const viewer = buildActor({ userId: 1, isSuperadmin: false }, [
                { teamId: otherTeamId, roleSlug: "viewer" },
            ]);

            await assert.rejects(
                Proxy.save(
                    { protocol: "http", host: "viewer-should-not-update.example.com", port: 80 },
                    proxyInOtherTeamId,
                    1,
                    viewer
                ),
                ForbiddenError
            );
        });

        test("Proxy.save creating a NEW proxy (falsy proxyID) is gated by proxy:manage instead of requireResource", async () => {
            // No existing resourceId to resolve a team from, so requireResource is
            // never invoked -- but the create path must still be gated via
            // requirePermission against the actor's own active team.
            const owner = buildActor({ userId: 1, isSuperadmin: false }, [{ teamId: otherTeamId, roleSlug: "owner" }]);
            const bean = await Proxy.save(
                { protocol: "http", host: "created-while-on.example.com", port: 8000 },
                null,
                1,
                owner
            );
            assert.ok(bean.id);
            assert.strictEqual(bean.team_id, otherTeamId);
        });

        test("Proxy.save creating a NEW proxy is denied for an actor lacking proxy:manage", async () => {
            const noTeams = buildActor({ userId: 1, isSuperadmin: false }, []);
            await assert.rejects(
                Proxy.save(
                    { protocol: "http", host: "should-not-be-created.example.com", port: 8001 },
                    null,
                    1,
                    noTeams
                ),
                ForbiddenError
            );
        });

        test("member of the owning team can delete", async () => {
            const bean = R.dispense("proxy");
            bean.user_id = 1;
            bean.protocol = "http";
            bean.host = "deletable.example.com";
            bean.port = 3001;
            bean.team_id = otherTeamId;
            const id = await R.store(bean);

            const member = buildActor({ userId: 1, isSuperadmin: false }, [{ teamId: otherTeamId, roleSlug: "owner" }]);

            await Proxy.delete(id, 1, member);

            const found = await R.findOne("proxy", " id = ? ", [id]);
            assert.strictEqual(found, null);
        });
    });
});
