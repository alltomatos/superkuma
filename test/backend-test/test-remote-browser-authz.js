process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { RemoteBrowser } = require("../../server/remote-browser");
const { buildActor, ForbiddenError } = require("../../server/security/authz");

describe("RemoteBrowser model — RBAC retrofit (ADR-0010)", () => {
    const testDb = new TestDB("./data/test-remote-browser-authz");

    // Two real teams, an owner-role member of each, and a remote browser row
    // owned by team B -- so an actor in team A is a genuine cross-tenant caller.
    let teamAId;
    let teamBId;
    let actorInTeamA;
    let actorInTeamB;
    let remoteBrowserIdInTeamB;

    before(async () => {
        await testDb.create();

        const ownerRole = await R.knex("role").whereNull("team_id").andWhere("slug", "owner").first();

        teamAId = await R.knex("team").insert({ name: "Team A", slug: "team-a", is_system: false });
        teamBId = await R.knex("team").insert({ name: "Team B", slug: "team-b", is_system: false });
        teamAId = Array.isArray(teamAId) ? teamAId[0] : teamAId;
        teamBId = Array.isArray(teamBId) ? teamBId[0] : teamBId;

        const userAId = await R.knex("user").insert({ username: "authz-team-a-user", password: "x" });
        const userBId = await R.knex("user").insert({ username: "authz-team-b-user", password: "x" });
        const resolvedUserAId = Array.isArray(userAId) ? userAId[0] : userAId;
        const resolvedUserBId = Array.isArray(userBId) ? userBId[0] : userBId;

        await R.knex("team_user").insert({ team_id: teamAId, user_id: resolvedUserAId, role_id: ownerRole.id });
        await R.knex("team_user").insert({ team_id: teamBId, user_id: resolvedUserBId, role_id: ownerRole.id });

        actorInTeamA = buildActor(
            { userId: resolvedUserAId, isSuperadmin: false },
            [{ teamId: teamAId, roleId: ownerRole.id, roleSlug: "owner" }],
            teamAId
        );
        actorInTeamB = buildActor(
            { userId: resolvedUserBId, isSuperadmin: false },
            [{ teamId: teamBId, roleId: ownerRole.id, roleSlug: "owner" }],
            teamBId
        );

        // Remote browser row is owned (legacy per-user column) by team B's user,
        // and its team_id (the RBAC-resolved column) also points at team B.
        const bean = R.dispense("remote_browser");
        bean.name = "team-b-browser";
        bean.url = "ws://example.com/playwright";
        bean.user_id = resolvedUserBId;
        bean.team_id = teamBId;
        remoteBrowserIdInTeamB = await R.store(bean);
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    // ---------------------------------------------------------------------
    // No actor (or an actor with zero relevant access): everything is denied,
    // with no actor-optional escape hatch anywhere in the model.
    // ---------------------------------------------------------------------
    describe("actor has no access", () => {
        test("get() denies when actor is omitted", async () => {
            await assert.rejects(
                RemoteBrowser.get(remoteBrowserIdInTeamB, actorInTeamB.userId, undefined),
                ForbiddenError
            );
        });

        test("save() (create) denies when actor is omitted", async () => {
            await assert.rejects(
                RemoteBrowser.save({ name: "no-actor", url: "ws://example.com/a" }, null, actorInTeamA.userId, undefined),
                ForbiddenError
            );
        });

        test("delete() denies when actor is omitted", async () => {
            const created = await RemoteBrowser.save(
                { name: "to-delete-no-actor", url: "ws://example.com/b" },
                null,
                actorInTeamA.userId,
                actorInTeamA
            );
            await assert.rejects(RemoteBrowser.delete(created.id, actorInTeamA.userId, undefined), ForbiddenError);

            const stillThere = await R.findOne("remote_browser", " id = ? ", [created.id]);
            assert.ok(stillThere, "resource must survive a denied delete attempt");
        });
    });

    // ---------------------------------------------------------------------
    // Real cross-team denial through the actual model methods, resolved via
    // the real teamIdLoader against the DB row.
    // ---------------------------------------------------------------------
    describe("cross-team access", () => {
        test("get() denies an actor from a different team than the resource's resolved team_id", async () => {
            await assert.rejects(
                RemoteBrowser.get(remoteBrowserIdInTeamB, actorInTeamB.userId, actorInTeamA),
                ForbiddenError
            );
        });

        test("get() allows an actor who is a member of the resource's resolved team_id", async () => {
            const bean = await RemoteBrowser.get(remoteBrowserIdInTeamB, actorInTeamB.userId, actorInTeamB);
            assert.strictEqual(bean.id, remoteBrowserIdInTeamB);
        });

        test("save() (edit) denies an actor from a different team than the resource's resolved team_id", async () => {
            await assert.rejects(
                RemoteBrowser.save(
                    { name: "hostile-edit", url: "ws://example.com/hostile" },
                    remoteBrowserIdInTeamB,
                    actorInTeamB.userId,
                    actorInTeamA
                ),
                ForbiddenError
            );
        });

        test("save() (create, no id) never calls requireResource (no existing resource to resolve a team from), but is still gated by remote_browser:manage", async () => {
            const created = await RemoteBrowser.save(
                { name: "on-create", url: "ws://example.com/on-create" },
                null,
                actorInTeamA.userId,
                actorInTeamA
            );
            assert.ok(created.id);
            assert.strictEqual(created.team_id, teamAId);
        });

        test("save() (create) is denied for an actor lacking remote_browser:manage", async () => {
            const noTeams = buildActor({ userId: actorInTeamA.userId, isSuperadmin: false }, []);
            await assert.rejects(
                RemoteBrowser.save({ name: "should-not-exist", url: "ws://example.com/x" }, null, actorInTeamA.userId, noTeams),
                ForbiddenError
            );
        });

        test("delete() denies an actor from a different team than the resource's resolved team_id", async () => {
            await assert.rejects(
                RemoteBrowser.delete(remoteBrowserIdInTeamB, actorInTeamB.userId, actorInTeamA),
                ForbiddenError
            );

            // Row must still exist -- the denial happened before any mutation.
            const stillThere = await R.findOne("remote_browser", " id = ? ", [remoteBrowserIdInTeamB]);
            assert.ok(stillThere, "resource must survive a denied delete attempt");
        });

        test("delete() allows an actor who is a member of the resource's resolved team_id", async () => {
            const created = await RemoteBrowser.save(
                { name: "on-delete", url: "ws://example.com/on-delete" },
                null,
                actorInTeamB.userId,
                actorInTeamB
            );
            assert.strictEqual(created.team_id, teamBId);

            await RemoteBrowser.delete(created.id, actorInTeamB.userId, actorInTeamB);

            const gone = await R.findOne("remote_browser", " id = ? ", [created.id]);
            assert.strictEqual(gone, null);
        });
    });
});
