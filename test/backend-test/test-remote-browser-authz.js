process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { RemoteBrowser } = require("../../server/remote-browser");
const { buildActor, setEnforcementEnabled, ForbiddenError } = require("../../server/security/authz");

describe("RemoteBrowser model — RBAC retrofit (P3, dark-launch)", () => {
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
    // Enforcement OFF (default / dark-launch): behaviour is unchanged.
    // ---------------------------------------------------------------------
    describe("enforcement OFF (dark-launch default)", () => {
        test("get() returns the row for any actor, including a different team, and even with actor omitted", async () => {
            const bean = await RemoteBrowser.get(remoteBrowserIdInTeamB, actorInTeamB.userId, actorInTeamB);
            assert.strictEqual(bean.id, remoteBrowserIdInTeamB);

            // Cross-team actor: still allowed while OFF, matching legacy behaviour
            // (the legacy user_id check would reject it, but the RBAC gate itself
            // must not be what blocks it while enforcement is off).
            let rejected = false;
            try {
                await RemoteBrowser.get(remoteBrowserIdInTeamB, actorInTeamA.userId, actorInTeamA);
            } catch (e) {
                rejected = true;
                assert.ok(!(e instanceof ForbiddenError), "must not fail with ForbiddenError while OFF");
                assert.match(e.message, /not found/i, "must fail via the legacy user_id check, not RBAC");
            }
            assert.strictEqual(rejected, true, "legacy user_id mismatch still rejects (unchanged behaviour)");

            // No actor at all (e.g. a caller that hasn't been threaded through yet)
            // must still work -- requireResource is a true no-op while OFF.
            const beanNoActor = await RemoteBrowser.get(remoteBrowserIdInTeamB, actorInTeamB.userId, undefined);
            assert.strictEqual(beanNoActor.id, remoteBrowserIdInTeamB);
        });

        test("save() creates and updates without consulting RBAC", async () => {
            const created = await RemoteBrowser.save(
                { name: "off-create", url: "ws://example.com/a" },
                null,
                actorInTeamA.userId,
                actorInTeamA
            );
            assert.ok(created.id);

            const updated = await RemoteBrowser.save(
                { name: "off-update", url: "ws://example.com/b" },
                created.id,
                actorInTeamA.userId,
                actorInTeamA
            );
            assert.strictEqual(updated.name, "off-update");
        });

        test("delete() removes the row without consulting RBAC", async () => {
            const created = await RemoteBrowser.save(
                { name: "off-delete", url: "ws://example.com/c" },
                null,
                actorInTeamA.userId,
                actorInTeamA
            );
            await RemoteBrowser.delete(created.id, actorInTeamA.userId, actorInTeamA);

            const gone = await R.findOne("remote_browser", " id = ? ", [created.id]);
            assert.strictEqual(gone, null);
        });
    });

    // ---------------------------------------------------------------------
    // Enforcement ON (test-only): real cross-team denial through the actual
    // model methods, resolved via the real teamIdLoader against the DB row.
    // ---------------------------------------------------------------------
    describe("enforcement ON (test-only)", () => {
        before(() => setEnforcementEnabled(true));
        after(() => setEnforcementEnabled(false));

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

        test("save() (create, no id) is unaffected by team scoping since there is no existing resource", async () => {
            const created = await RemoteBrowser.save(
                { name: "on-create", url: "ws://example.com/on-create" },
                null,
                actorInTeamA.userId,
                actorInTeamA
            );
            assert.ok(created.id);
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
            // save() intentionally does not populate team_id on create -- that
            // column switch is deferred to P4 (ADR-0010). Set it directly here to
            // simulate a post-P4 row and exercise the "allowed" branch of delete().
            await R.knex("remote_browser").where("id", created.id).update({ team_id: teamBId });

            await RemoteBrowser.delete(created.id, actorInTeamB.userId, actorInTeamB);

            const gone = await R.findOne("remote_browser", " id = ? ", [created.id]);
            assert.strictEqual(gone, null);
        });
    });
});
