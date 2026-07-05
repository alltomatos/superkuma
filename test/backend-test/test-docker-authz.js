process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const knexLib = require("knex");
const { R } = require("redbean-node");
const migration = require("../../db/knex_migrations/2026-07-04-0000-create-rbac-schema");
const { buildActor, setEnforcementEnabled, ForbiddenError } = require("../../server/security/authz");
const { DockerHost } = require("../../server/docker");

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
 * Build a stubbed schema (mirroring test-actor-repository.js) with the real
 * columns DockerHost.save()/delete() read and write, then run the RBAC
 * migration so docker_host gains a team_id column.
 * @param {object} db The Knex instance.
 * @returns {Promise<void>}
 */
const seedSchema = async (db) => {
    await db.raw("PRAGMA foreign_keys = OFF");
    await db.schema.createTable("user", (t) => {
        t.increments("id");
        t.string("username");
    });
    await db.schema.createTable("docker_host", (t) => {
        t.increments("id");
        t.integer("user_id");
        t.string("docker_daemon");
        t.string("docker_type");
        t.string("name");
    });
    await db.schema.createTable("monitor", (t) => {
        t.increments("id");
        t.integer("user_id");
        t.integer("docker_host");
    });
    for (const name of RESOURCE_TABLES.filter((n) => n !== "docker_host" && n !== "monitor")) {
        await db.schema.createTable(name, (t) => t.increments("id"));
    }
    await db.schema.createTable("status_page", (t) => t.increments("id"));
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
        { id: 1, username: "owner-a" },
        { id: 2, username: "owner-b" },
        { id: 3, username: "member-a" },
    ]);
    await migration.up(db);
};

/**
 * Create a second team (the migration only creates the backfilled "Default
 * Team") and move a given user into it under the given built-in role.
 * @param {object} db The Knex instance.
 * @param {string} slug Unique slug for the new team.
 * @param {number} userId The user to (re)assign into the new team.
 * @param {string} roleSlug Built-in role slug to grant (e.g. "owner").
 * @returns {Promise<number>} The new team's id.
 */
const makeTeam = async (db, slug, userId, roleSlug) => {
    await db("team").insert({ name: slug, slug, is_system: false, active: true });
    const team = await db("team").where("slug", slug).first();
    const role = await db("role").whereNull("team_id").andWhere("slug", roleSlug).first();

    // Remove any existing membership for this user so they act ONLY in the new
    // team for this test (keeps the two-team scenario unambiguous).
    await db("team_user").where("user_id", userId).del();
    await db("team_user").insert({ team_id: team.id, user_id: userId, role_id: role.id });

    return team.id;
};

/**
 * Build an RBAC actor for a user given their current team_user memberships.
 * @param {object} db The Knex instance.
 * @param {number} userId The user id.
 * @returns {Promise<object>} The constructed actor.
 */
const actorFor = async (db, userId) => {
    const rows = await db("team_user as tu")
        .join("role as r", "r.id", "tu.role_id")
        .where("tu.user_id", userId)
        .select("tu.team_id as teamId", "tu.role_id as roleId", "r.slug as roleSlug");
    const user = await db("user").where("id", userId).first();
    return buildActor({ userId, isSuperadmin: Boolean(user.is_superadmin) }, rows);
};

describe("docker.js DockerHost authz retrofit (ADR-0010 P3, dark-launch)", () => {
    let db;
    let teamBId;
    let actorA;
    let actorB;
    let dockerHostInTeamB;

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
        await seedSchema(db);

        // NOTE: user 1 is the lowest user id, so the RBAC migration bootstraps it
        // as the global superadmin (which bypasses every check in can()). Using it
        // as the "foreign" actor would make the cross-team-denial assertions below
        // pass for the wrong reason. User 3 ("member-a") is an ordinary, non-super
        // owner of team A and is the actor actually used for those assertions.
        await makeTeam(db, "team-a", 3, "owner");
        teamBId = await makeTeam(db, "team-b", 2, "owner");
        actorA = await actorFor(db, 3);
        actorB = await actorFor(db, 2);

        // A docker host owned (by legacy user_id) by user 2, scoped to team B.
        const [id] = await db("docker_host").insert({
            user_id: 2,
            docker_daemon: "/var/run/docker.sock",
            docker_type: "socket",
            name: "team-b-host",
            team_id: teamBId,
        });
        dockerHostInTeamB = id;
    });

    after(async () => {
        await db.destroy();
    });

    describe("enforcement OFF (default) - behaviour unchanged", () => {
        before(() => setEnforcementEnabled(false));

        test("save() creates a new docker host exactly as before, actor ignored", async () => {
            const bean = await DockerHost.save(
                { dockerDaemon: "/var/run/docker.sock", dockerType: "socket", name: "new-host" },
                null,
                3,
                actorA
            );
            assert.ok(bean.id);
            assert.strictEqual(bean.name, "new-host");
            assert.strictEqual(bean.user_id, 3);
        });

        test("save() updates an existing docker host across the user_id check unchanged, even with a foreign actor", async () => {
            // actorA is a member of team A only; dockerHostInTeamB belongs to team B.
            // With enforcement OFF this must still succeed exactly like pre-RBAC code,
            // because requireResource() is a pure no-op.
            const updated = await DockerHost.save(
                { dockerDaemon: "/var/run/docker.sock", dockerType: "socket", name: "renamed-by-a" },
                dockerHostInTeamB,
                2,
                actorA
            );
            assert.strictEqual(updated.id, dockerHostInTeamB);
            assert.strictEqual(updated.name, "renamed-by-a");
        });

        test("save() with a foreign actor but wrong userID in the WHERE clause still fails with 'docker host not found' (legacy check untouched)", async () => {
            await assert.rejects(
                DockerHost.save(
                    { dockerDaemon: "/var/run/docker.sock", dockerType: "socket", name: "x" },
                    dockerHostInTeamB,
                    999,
                    actorA
                ),
                /docker host not found/
            );
        });

        test("save() with actor undefined still works (no null-guard needed; requireResource is a no-op)", async () => {
            const bean = await DockerHost.save(
                { dockerDaemon: "/var/run/docker.sock", dockerType: "socket", name: "no-actor" },
                null,
                3,
                undefined
            );
            assert.ok(bean.id);
        });

        test("delete() removes an existing docker host across the user_id check unchanged, even with a foreign actor", async () => {
            const [id] = await db("docker_host").insert({
                user_id: 2,
                docker_daemon: "/var/run/docker.sock",
                docker_type: "socket",
                name: "to-delete",
                team_id: teamBId,
            });
            await DockerHost.delete(id, 2, actorA);
            const row = await db("docker_host").where("id", id).first();
            assert.strictEqual(row, undefined);
        });
    });

    describe("enforcement ON - real cross-team denial through the actual save()/delete() methods", () => {
        before(() => setEnforcementEnabled(true));
        after(() => setEnforcementEnabled(false));

        test("actor in team A cannot save() (update) a docker host owned by team B", async () => {
            await assert.rejects(
                DockerHost.save(
                    { dockerDaemon: "/var/run/docker.sock", dockerType: "socket", name: "hijacked" },
                    dockerHostInTeamB,
                    2,
                    actorA
                ),
                ForbiddenError
            );
        });

        test("actor in team A cannot delete() a docker host owned by team B", async () => {
            await assert.rejects(DockerHost.delete(dockerHostInTeamB, 2, actorA), ForbiddenError);
        });

        test("actor in team B (the owning team) CAN save() (update) their own docker host", async () => {
            const updated = await DockerHost.save(
                { dockerDaemon: "/var/run/docker.sock", dockerType: "socket", name: "renamed-by-owner" },
                dockerHostInTeamB,
                2,
                actorB
            );
            assert.strictEqual(updated.id, dockerHostInTeamB);
            assert.strictEqual(updated.name, "renamed-by-owner");
        });

        test("actor in team B (the owning team) CAN delete() their own docker host", async () => {
            const [id] = await db("docker_host").insert({
                user_id: 2,
                docker_daemon: "/var/run/docker.sock",
                docker_type: "socket",
                name: "owned-by-b",
                team_id: teamBId,
            });
            await DockerHost.delete(id, 2, actorB);
            const row = await db("docker_host").where("id", id).first();
            assert.strictEqual(row, undefined);
        });

        test("save() creating a brand-new docker host (no dockerHostID) never calls requireResource, so it is unaffected by team membership", async () => {
            const bean = await DockerHost.save(
                { dockerDaemon: "/var/run/docker.sock", dockerType: "socket", name: "fresh" },
                null,
                3,
                actorA
            );
            assert.ok(bean.id);
        });
    });
});
