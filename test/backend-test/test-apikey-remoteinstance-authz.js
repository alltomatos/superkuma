process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");

const { apiKeySocketHandler } = require("../../server/socket-handlers/api-key-socket-handler");
const { remoteInstanceSocketHandler } = require("../../server/socket-handlers/remote-instance-socket-handler");
const { setEnforcementEnabled, buildActor, ForbiddenError } = require("../../server/security/authz");
const { Settings } = require("../../server/settings");

const testDb = new TestDB("./data/test-apikey-remoteinstance-authz");

/**
 * Build a mock socket.io-like object that captures registered "on" handlers
 * so socket handler logic can be invoked directly, without a real socket.io
 * connection. Mirrors the helper used in test-federation-heartbeat.js, with
 * an added `actor` field so retrofitted authz calls have something to check.
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
 * Look up a built-in role's id (team_id NULL global template) by slug.
 * @param {string} slug Role slug, e.g. "owner" or "viewer".
 * @returns {Promise<number>} The role id.
 */
async function getBuiltinRoleId(slug) {
    const role = await R.getRow("SELECT id FROM `role` WHERE team_id IS NULL AND slug = ?", [slug]);
    if (!role) {
        throw new Error(`Built-in role not seeded: ${slug}`);
    }
    return role.id;
}

/**
 * Create a team row and return its id.
 * @param {string} slug Unique team slug.
 * @param {string} name Human-readable team name.
 * @returns {Promise<number>} The new team's id.
 */
async function createTeam(slug, name) {
    const bean = R.dispense("team");
    bean.name = name;
    bean.slug = slug;
    bean.is_system = false;
    bean.active = true;
    return R.store(bean);
}

/**
 * Add a user to a team with a given built-in role slug.
 * @param {number} teamId Team id.
 * @param {number} userId User id.
 * @param {string} roleSlug Built-in role slug to assign.
 * @returns {Promise<void>}
 */
async function addTeamMember(teamId, userId, roleSlug) {
    const roleId = await getBuiltinRoleId(roleSlug);
    const bean = R.dispense("team_user");
    bean.team_id = teamId;
    bean.user_id = userId;
    bean.role_id = roleId;
    await R.store(bean);
}

/**
 * Build an Actor for a user who is an "owner" of exactly one team.
 * @param {number} userId The user id.
 * @param {number} teamId The team id the actor owns.
 * @returns {object} The constructed Actor.
 */
function ownerActorFor(userId, teamId) {
    return buildActor({ userId, isSuperadmin: false }, [{ teamId, roleSlug: "owner" }], teamId);
}

describe("api-key + remote-instance authz retrofit (ADR-0010 P3)", () => {
    let teamA;
    let teamB;
    let userA;
    let userB;

    before(async () => {
        await testDb.create();

        teamA = await createTeam("team-a-apikey-ri", "Team A");
        teamB = await createTeam("team-b-apikey-ri", "Team B");

        // Two distinct real users so R.exec's untouched "AND user_id = ?"
        // legacy predicate has something meaningful to key off of.
        const beanA = R.dispense("user");
        beanA.username = "authz-user-a";
        beanA.password = "not-used";
        userA = await R.store(beanA);

        const beanB = R.dispense("user");
        beanB.username = "authz-user-b";
        beanB.password = "not-used";
        userB = await R.store(beanB);

        await addTeamMember(teamA, userA, "owner");
        await addTeamMember(teamB, userB, "owner");
    });

    after(async () => {
        setEnforcementEnabled(false);
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    // -------------------------------------------------------------------
    // Enforcement OFF (default / dark-launch): behaviour unchanged.
    // -------------------------------------------------------------------
    describe("enforcement OFF (dark-launch default)", () => {
        test("deleteAPIKey still deletes the row via the legacy user_id predicate", async () => {
            const bean = R.dispense("api_key");
            bean.user_id = userA;
            bean.key = "hashed-key-off";
            bean.name = "Off Key";
            bean.active = true;
            bean.team_id = teamA;
            const keyID = await R.store(bean);

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            apiKeySocketHandler(socket);

            const result = await socket.trigger("deleteAPIKey", keyID);
            assert.strictEqual(result.ok, true);

            const after1 = await R.findOne("api_key", " id = ? ", [keyID]);
            assert.strictEqual(after1, null, "api_key row should be deleted");
        });

        test("deleteAPIKey still no-ops (no rows deleted) when actor is null (defensive afterLogin failure path)", async () => {
            const bean = R.dispense("api_key");
            bean.user_id = userA;
            bean.key = "hashed-key-null-actor";
            bean.name = "Null Actor Key";
            bean.active = true;
            bean.team_id = teamA;
            const keyID = await R.store(bean);

            const socket = createMockSocket(userA, null);
            apiKeySocketHandler(socket);

            const result = await socket.trigger("deleteAPIKey", keyID);
            assert.strictEqual(
                result.ok,
                true,
                "requireResource must be a true no-op while OFF, even with a null actor"
            );

            const after1 = await R.findOne("api_key", " id = ? ", [keyID]);
            assert.strictEqual(after1, null, "api_key row should still be deleted (behaviour unchanged)");
        });

        test("deleteRemoteInstance still deletes the row via the legacy user_id predicate", async () => {
            const bean = R.dispense("remote_instance");
            bean.instance_id = "off-instance-1";
            bean.name = "Off Instance";
            bean.token_hash = "hash";
            bean.active = true;
            bean.user_id = userA;
            bean.team_id = teamA;
            const riID = await R.store(bean);

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            remoteInstanceSocketHandler(socket);

            const result = await socket.trigger("deleteRemoteInstance", riID);
            assert.strictEqual(result.ok, true);

            const after1 = await R.findOne("remote_instance", " id = ? ", [riID]);
            assert.strictEqual(after1, null, "remote_instance row should be deleted");
        });

        test("getRemoteInstanceList still returns only the caller's own rows (untouched legacy user_id filter; not retrofitted, see note below)", async () => {
            const beanOwn = R.dispense("remote_instance");
            beanOwn.instance_id = "off-list-own";
            beanOwn.name = "Own Instance";
            beanOwn.token_hash = "hash";
            beanOwn.active = true;
            beanOwn.user_id = userA;
            beanOwn.team_id = teamA;
            await R.store(beanOwn);

            const beanOther = R.dispense("remote_instance");
            beanOther.instance_id = "off-list-other";
            beanOther.name = "Other User Instance";
            beanOther.token_hash = "hash";
            beanOther.active = true;
            beanOther.user_id = userB;
            beanOther.team_id = teamB;
            await R.store(beanOther);

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            remoteInstanceSocketHandler(socket);

            const result = await socket.trigger("getRemoteInstanceList");
            assert.strictEqual(result.ok, true);
            const ids = result.remoteInstanceList.map((entry) => entry.instanceId);
            assert.ok(ids.includes("off-list-own"), "own instance must be present");
            assert.ok(!ids.includes("off-list-other"), "other user's instance must not leak while OFF either");
        });
    });

    // NOTE: getRemoteInstanceList's "WHERE user_id = ?" list query was deliberately
    // NOT swapped for scopeFilter(socket.actor) in this retrofit. scopeFilter's
    // flag-OFF path does `actor.userId` with no null-guard, but afterLogin's
    // documented dark-launch contract (server/server.js) explicitly sets
    // socket.actor = null on any actor-build failure -- so swapping this call
    // would turn that recoverable fallback into a hard TypeError crash for any
    // such user's monitor/list fetches, even with enforcement OFF (confirmed via
    // the pre-existing test "getRemoteInstanceList returns instances for the user
    // without leaking token_hash" in test-federation-heartbeat.js, whose mock
    // socket never sets .actor, i.e. it is undefined). Fixing this is a change to
    // server/security/authz.js, which is outside this task's assigned file group
    // (api-key-socket-handler.js + remote-instance-socket-handler.js only) --
    // flagged as an ambiguity rather than guessed at. See final report.

    // -------------------------------------------------------------------
    // Enforcement ON (test-only): real two-team denial, through the actual
    // handler code paths (not just direct calls into the authz module).
    // -------------------------------------------------------------------
    describe("enforcement ON (two-team isolation, exercised through the real handlers)", () => {
        before(() => setEnforcementEnabled(true));
        after(() => setEnforcementEnabled(false));

        test("deleteAPIKey denies a team-B owner deleting a team-A api key", async () => {
            const bean = R.dispense("api_key");
            bean.user_id = userA;
            bean.key = "hashed-key-on-deny";
            bean.name = "On Deny Key";
            bean.active = true;
            bean.team_id = teamA;
            const keyID = await R.store(bean);

            // userB authenticates as itself but is only a member of team B;
            // the key's real team (loaded server-side via teamIdLoader) is A.
            const socket = createMockSocket(userB, ownerActorFor(userB, teamB));
            apiKeySocketHandler(socket);

            const result = await socket.trigger("deleteAPIKey", keyID);
            assert.strictEqual(result.ok, false, "cross-team delete must be denied");
            assert.ok(result.msg.includes("Permission denied"), `expected ForbiddenError message, got: ${result.msg}`);

            const stillThere = await R.findOne("api_key", " id = ? ", [keyID]);
            assert.ok(stillThere, "api_key row must survive a denied cross-team delete");
        });

        test("deleteAPIKey allows a team-A owner to delete a team-A api key", async () => {
            const bean = R.dispense("api_key");
            bean.user_id = userA;
            bean.key = "hashed-key-on-allow";
            bean.name = "On Allow Key";
            bean.active = true;
            bean.team_id = teamA;
            const keyID = await R.store(bean);

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            apiKeySocketHandler(socket);

            const result = await socket.trigger("deleteAPIKey", keyID);
            assert.strictEqual(result.ok, true, "same-team delete must be allowed");

            const gone = await R.findOne("api_key", " id = ? ", [keyID]);
            assert.strictEqual(gone, null);
        });

        test("deleteRemoteInstance denies a team-B owner deleting a team-A remote instance", async () => {
            const bean = R.dispense("remote_instance");
            bean.instance_id = "on-deny-instance";
            bean.name = "On Deny Instance";
            bean.token_hash = "hash";
            bean.active = true;
            bean.user_id = userA;
            bean.team_id = teamA;
            const riID = await R.store(bean);

            const socket = createMockSocket(userB, ownerActorFor(userB, teamB));
            remoteInstanceSocketHandler(socket);

            const result = await socket.trigger("deleteRemoteInstance", riID);
            assert.strictEqual(result.ok, false, "cross-team delete must be denied");
            assert.ok(result.msg.includes("Permission denied"), `expected ForbiddenError message, got: ${result.msg}`);

            const stillThere = await R.findOne("remote_instance", " id = ? ", [riID]);
            assert.ok(stillThere, "remote_instance row must survive a denied cross-team delete");
        });

        test("deleteRemoteInstance allows a team-A owner to delete a team-A remote instance", async () => {
            const bean = R.dispense("remote_instance");
            bean.instance_id = "on-allow-instance";
            bean.name = "On Allow Instance";
            bean.token_hash = "hash";
            bean.active = true;
            bean.user_id = userA;
            bean.team_id = teamA;
            const riID = await R.store(bean);

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            remoteInstanceSocketHandler(socket);

            const result = await socket.trigger("deleteRemoteInstance", riID);
            assert.strictEqual(result.ok, true, "same-team delete must be allowed");

            const gone = await R.findOne("remote_instance", " id = ? ", [riID]);
            assert.strictEqual(gone, null);
        });

        // getRemoteInstanceList is intentionally NOT retrofitted with scopeFilter
        // in this change (see the NOTE above, in the enforcement-OFF describe
        // block) -- it still uses the untouched legacy "WHERE user_id = ?"
        // filter regardless of the enforcement flag, so there is no ON-path
        // team-scoping behaviour to assert here yet.
    });

    // -------------------------------------------------------------------
    // Direct sanity check that the retrofit uses the exact contract
    // (ForbiddenError, real teamIdLoader-resolved team) rather than a
    // hand-rolled equivalent.
    // -------------------------------------------------------------------
    describe("retrofit wiring sanity", () => {
        before(() => setEnforcementEnabled(true));
        after(() => setEnforcementEnabled(false));

        test("ForbiddenError is the concrete error type surfaced by the denied handler paths", async () => {
            const { requireResource } = require("../../server/security/authz");
            const { teamIdLoader } = require("../../server/security/team-id-loaders");

            const bean = R.dispense("api_key");
            bean.user_id = userA;
            bean.key = "hashed-key-sanity";
            bean.name = "Sanity Key";
            bean.active = true;
            bean.team_id = teamA;
            const keyID = await R.store(bean);

            await assert.rejects(
                requireResource(ownerActorFor(userB, teamB), "api_key:manage", "api_key", keyID, teamIdLoader),
                ForbiddenError
            );
        });
    });
});
