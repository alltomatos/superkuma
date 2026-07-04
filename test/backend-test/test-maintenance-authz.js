process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

// Maintenance.toJSON() formats dates via dayjs().tz(...); server.js normally
// registers this plugin at boot, but a standalone test process doesn't get it
// for free -- register it here so the real handler's date formatting works
// when this file is run in isolation (not just as part of the full suite).
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { buildActor, requireResource, setEnforcementEnabled, ForbiddenError } = require("../../server/security/authz");
const { teamIdLoader } = require("../../server/security/team-id-loaders");
const { maintenanceSocketHandler } = require("../../server/socket-handlers/maintenance-socket-handler");

/**
 * Build a mock socket.io-like object that captures registered "on" handlers
 * so socket handler logic can be invoked directly, without a real socket.io
 * connection. Mirrors the helper used in test-status-page-authz.js /
 * test-apikey-remoteinstance-authz.js.
 * @param {number} userID Fake logged-in user id to attach to the mock socket
 * @param {object|null} actor Actor object to attach as socket.actor
 * @returns {{userID: number, actor: object|null, on: Function, trigger: Function}} Mock socket
 */
function createMockSocket(userID, actor) {
    const handlers = {};
    return {
        userID,
        actor: actor === undefined ? null : actor,
        on(event, handler) {
            handlers[event] = handler;
        },
        /**
         * Invoke a previously-registered handler by event name.
         * @param {string} event Event name
         * @param {...any} args Arguments to forward to the handler
         * @returns {Promise<any>} Whatever the handler's callback receives
         */
        trigger(event, ...args) {
            return new Promise((resolve, reject) => {
                if (!handlers[event]) {
                    reject(new Error(`No handler registered for event: ${event}`));
                    return;
                }
                handlers[event](...args, (result) => resolve(result));
            });
        },
    };
}

/**
 * Insert a minimal, valid `maintenance` row owned by the given user/team.
 * @param {object} options Row fields.
 * @param {number} options.userId The legacy owning user id (kept for the
 * unchanged `user_id` predicates the retrofit sits alongside).
 * @param {number} options.teamId The RBAC-resolved owning team id.
 * @param {string} options.title Maintenance title.
 * @returns {Promise<number>} The new maintenance id.
 */
async function createMaintenance({ userId, teamId, title }) {
    let bean = R.dispense("maintenance");
    bean.title = title;
    bean.description = "test maintenance window";
    bean.user_id = userId;
    bean.team_id = teamId;
    bean.strategy = "manual";
    bean.active = true;
    return R.store(bean);
}

describe("maintenance-socket-handler authz retrofit", () => {
    const testDb = new TestDB("./data/test-maintenance-authz");

    /** @type {{id: number}} */
    let userA;
    /** @type {{id: number}} */
    let userB;
    /** @type {number} */
    let teamAId;
    /** @type {number} */
    let teamBId;
    /** @type {number} */
    let maintenanceOwnedByTeamA;

    before(async () => {
        await testDb.create();

        // The RBAC migration backfills a single "Default Team" and folds every
        // existing user into it as owner. For a real two-team scenario we need
        // a second team + a distinct membership, so build that by hand here
        // (mirrors how test-actor-repository.js / test-team-id-loaders.js seed
        // their own RBAC fixtures against the real schema).
        const userABean = R.dispense("user");
        userABean.username = "maint-authz-user-a";
        userABean.password = "not-used";
        userA = { id: await R.store(userABean) };

        const userBBean = R.dispense("user");
        userBBean.username = "maint-authz-user-b";
        userBBean.password = "not-used";
        userB = { id: await R.store(userBBean) };

        const teamABean = R.dispense("team");
        teamABean.name = "Team A";
        teamABean.slug = "team-a-maint-authz";
        teamABean.is_system = false;
        teamABean.active = true;
        teamAId = await R.store(teamABean);

        const teamBBean = R.dispense("team");
        teamBBean.name = "Team B";
        teamBBean.slug = "team-b-maint-authz";
        teamBBean.is_system = false;
        teamBBean.active = true;
        teamBId = await R.store(teamBBean);

        const viewerRole = await R.knex("role").whereNull("team_id").andWhere("slug", "viewer").first();
        const editorRole = await R.knex("role").whereNull("team_id").andWhere("slug", "editor").first();

        await R.knex("team_user").insert({ team_id: teamAId, user_id: userA.id, role_id: editorRole.id });
        await R.knex("team_user").insert({ team_id: teamBId, user_id: userB.id, role_id: viewerRole.id });

        maintenanceOwnedByTeamA = await createMaintenance({
            userId: userA.id,
            teamId: teamAId,
            title: "Team A window",
        });
    });

    after(async () => {
        setEnforcementEnabled(false);
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    describe("enforcement OFF (dark-launch default): behaviour unchanged", () => {
        test("requireResource is a true no-op and never touches the DB", async () => {
            assert.strictEqual(require("../../server/security/authz").isEnforcementEnabled(), false);

            let loaderCalled = false;
            const spyLoader = async (type, id) => {
                loaderCalled = true;
                return teamIdLoader(type, id);
            };

            // Same actor/action/resource shape the retrofit uses in every
            // handler; must resolve silently without ever calling the loader.
            const actorB = buildActor({ userId: userB.id, isSuperadmin: false }, [
                { teamId: teamBId, roleSlug: "viewer" },
            ]);
            await assert.doesNotReject(
                requireResource(actorB, "maintenance:delete", "maintenance", maintenanceOwnedByTeamA, spyLoader)
            );
            assert.strictEqual(loaderCalled, false, "loader must not run while enforcement is OFF");
        });

        test("getMaintenance's existing user_id-scoped query is untouched by the retrofit", async () => {
            // The legacy predicate is: id = ? AND user_id = ?. Prove it still
            // behaves exactly as before: userB (not the owner) gets no row back
            // via the legacy filter, independent of the (no-op) authz gate.
            const ownerBean = await R.findOne("maintenance", " id = ? AND user_id = ? ", [
                maintenanceOwnedByTeamA,
                userA.id,
            ]);
            assert.ok(ownerBean, "owner can still fetch via the unchanged legacy predicate");

            const otherBean = await R.findOne("maintenance", " id = ? AND user_id = ? ", [
                maintenanceOwnedByTeamA,
                userB.id,
            ]);
            assert.strictEqual(otherBean, null, "non-owner still denied by the unchanged legacy predicate");
        });
    });

    describe("enforcement ON (test-only): real two-team denial/allow", () => {
        before(() => setEnforcementEnabled(true));
        after(() => setEnforcementEnabled(false));

        test("actor in Team A (editor) may read/update/delete a Team A maintenance window", async () => {
            const actorA = buildActor({ userId: userA.id, isSuperadmin: false }, [
                { teamId: teamAId, roleSlug: "editor" },
            ]);

            await assert.doesNotReject(
                requireResource(actorA, "maintenance:read", "maintenance", maintenanceOwnedByTeamA, teamIdLoader)
            );
            await assert.doesNotReject(
                requireResource(actorA, "maintenance:update", "maintenance", maintenanceOwnedByTeamA, teamIdLoader)
            );
            await assert.doesNotReject(
                requireResource(actorA, "maintenance:delete", "maintenance", maintenanceOwnedByTeamA, teamIdLoader)
            );
        });

        test("actor in Team B (viewer, no membership in Team A) is denied on Team A's maintenance window", async () => {
            const actorB = buildActor({ userId: userB.id, isSuperadmin: false }, [
                { teamId: teamBId, roleSlug: "viewer" },
            ]);

            await assert.rejects(
                requireResource(actorB, "maintenance:read", "maintenance", maintenanceOwnedByTeamA, teamIdLoader),
                ForbiddenError
            );
            await assert.rejects(
                requireResource(actorB, "maintenance:update", "maintenance", maintenanceOwnedByTeamA, teamIdLoader),
                ForbiddenError
            );
            await assert.rejects(
                requireResource(actorB, "maintenance:delete", "maintenance", maintenanceOwnedByTeamA, teamIdLoader),
                ForbiddenError
            );
        });

        test("Team B viewer lacks maintenance:delete even within its own team (read-only role)", async () => {
            const maintenanceOwnedByTeamB = await createMaintenance({
                userId: userB.id,
                teamId: teamBId,
                title: "Team B window",
            });
            const actorB = buildActor({ userId: userB.id, isSuperadmin: false }, [
                { teamId: teamBId, roleSlug: "viewer" },
            ]);

            await assert.doesNotReject(
                requireResource(actorB, "maintenance:read", "maintenance", maintenanceOwnedByTeamB, teamIdLoader)
            );
            await assert.rejects(
                requireResource(actorB, "maintenance:delete", "maintenance", maintenanceOwnedByTeamB, teamIdLoader),
                ForbiddenError
            );
        });

        test("teamIdLoader resolves the real team_id backing the retrofit's calls (not a stub)", async () => {
            const resolved = await teamIdLoader("maintenance", maintenanceOwnedByTeamA);
            assert.strictEqual(resolved, teamAId);
        });
    });

    // -------------------------------------------------------------------
    // Real handler invocations (not authz.js in isolation): drives the actual
    // maintenanceSocketHandler via a mock socket + trigger(), proving the
    // retrofit is genuinely wired into getMaintenance/deleteMaintenance.
    // -------------------------------------------------------------------
    describe("through the real maintenanceSocketHandler (enforcement OFF)", () => {
        test("getMaintenance still succeeds via the legacy user_id predicate, even with a cross-team actor attached (requireResource is a no-op)", async () => {
            // Unlike status_page, maintenance already had a real per-user_id
            // predicate before this retrofit -- so "legacy behaviour unchanged"
            // means: socket.userID (the pre-existing identity) still governs
            // access exactly as before, and the new team-based requireResource
            // check does not add any extra blocking while OFF, even when the
            // attached actor is from a completely different team.
            const socket = createMockSocket(
                userA.id, // matches the row's legacy user_id
                buildActor({ userId: userB.id, isSuperadmin: false }, [{ teamId: teamBId, roleSlug: "viewer" }])
            );
            maintenanceSocketHandler(socket);

            const result = await socket.trigger("getMaintenance", maintenanceOwnedByTeamA);
            assert.strictEqual(result.ok, true, "requireResource must not block this while enforcement is OFF");
            assert.strictEqual(result.maintenance.id, maintenanceOwnedByTeamA);
        });

        test("postIncident-equivalent (deleteMaintenance) still no-ops safely with a null actor", async () => {
            const toDelete = await createMaintenance({ userId: userA.id, teamId: teamAId, title: "Null-actor delete" });
            const socket = createMockSocket(userA.id, null);
            maintenanceSocketHandler(socket);

            const result = await socket.trigger("deleteMaintenance", toDelete);
            assert.strictEqual(
                result.ok,
                true,
                "requireResource must be a true no-op while OFF, even with a null actor"
            );

            const gone = await R.findOne("maintenance", " id = ? ", [toDelete]);
            assert.strictEqual(gone, null, "deletion itself must have proceeded normally");
        });
    });

    describe("through the real maintenanceSocketHandler (enforcement ON, two-team isolation)", () => {
        before(() => setEnforcementEnabled(true));
        after(() => setEnforcementEnabled(false));

        test("getMaintenance denies a Team B actor reading a Team A window", async () => {
            const socket = createMockSocket(
                userB.id,
                buildActor({ userId: userB.id, isSuperadmin: false }, [{ teamId: teamBId, roleSlug: "viewer" }])
            );
            maintenanceSocketHandler(socket);

            const result = await socket.trigger("getMaintenance", maintenanceOwnedByTeamA);
            assert.strictEqual(result.ok, false, "cross-team read must be denied");
            assert.ok(result.msg.includes("Permission denied"), `expected ForbiddenError message, got: ${result.msg}`);
        });

        test("getMaintenance allows a Team A actor to read its own window", async () => {
            const socket = createMockSocket(
                userA.id,
                buildActor({ userId: userA.id, isSuperadmin: false }, [{ teamId: teamAId, roleSlug: "editor" }])
            );
            maintenanceSocketHandler(socket);

            const result = await socket.trigger("getMaintenance", maintenanceOwnedByTeamA);
            assert.strictEqual(result.ok, true, "same-team read must be allowed");
            assert.strictEqual(result.maintenance.id, maintenanceOwnedByTeamA);
        });

        test("deleteMaintenance denies a Team B actor deleting a Team A window (row survives)", async () => {
            const socket = createMockSocket(
                userB.id,
                buildActor({ userId: userB.id, isSuperadmin: false }, [{ teamId: teamBId, roleSlug: "viewer" }])
            );
            maintenanceSocketHandler(socket);

            const result = await socket.trigger("deleteMaintenance", maintenanceOwnedByTeamA);
            assert.strictEqual(result.ok, false, "cross-team delete must be denied");
            assert.ok(result.msg.includes("Permission denied"), `expected ForbiddenError message, got: ${result.msg}`);

            const stillThere = await R.findOne("maintenance", " id = ? ", [maintenanceOwnedByTeamA]);
            assert.ok(stillThere, "maintenance row must survive a denied cross-team delete");
        });

        test("deleteMaintenance allows a Team A actor to delete its own window", async () => {
            const toDelete = await createMaintenance({ userId: userA.id, teamId: teamAId, title: "To be deleted" });
            const socket = createMockSocket(
                userA.id,
                buildActor({ userId: userA.id, isSuperadmin: false }, [{ teamId: teamAId, roleSlug: "editor" }])
            );
            maintenanceSocketHandler(socket);

            const result = await socket.trigger("deleteMaintenance", toDelete);
            assert.strictEqual(result.ok, true, "same-team delete must be allowed");

            const gone = await R.findOne("maintenance", " id = ? ", [toDelete]);
            assert.strictEqual(gone, null);
        });
    });
});
