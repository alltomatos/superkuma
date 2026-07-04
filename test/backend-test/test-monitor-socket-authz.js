process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

// Monitor.toJSON() formats dates via dayjs().tz(...); server.js normally
// registers this plugin at boot, but a standalone test process doesn't get it
// for free -- register it here so the real handler's date formatting works
// when this file is run in isolation (not just as part of the full suite).
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));

const { describe, test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { buildActorForUser } = require("../../server/security/actor-repository");
const { teamIdLoader } = require("../../server/security/team-id-loaders");
const { requireResource, scopeFilter, setEnforcementEnabled, ForbiddenError } = require("../../server/security/authz");
const { monitorSocketHandler } = require("../../server/socket-handlers/monitor-socket-handler");

/**
 * Build a mock socket.io-like object that captures registered "on" handlers
 * so socket handler logic can be invoked directly, without a real socket.io
 * connection. Mirrors the helper used in test-status-page-authz.js /
 * test-maintenance-authz.js.
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
 * Minimal stub of the "server" object monitorSocketHandler's getMonitor/
 * getMonitorBeats/deleteMonitor code paths call methods on.
 * @returns {object} A stub server exposing no-op async methods.
 */
function createStubServer() {
    return {
        sendDeleteMonitorFromList: async () => {},
        sendUpdateMonitorIntoList: async () => {},
    };
}

/**
 * Creates and stores a Monitor bean with the given field overrides, mirroring
 * the bean construction idiom used by monitor-socket-handler.js's "add" handler.
 * @param {object} fields Monitor fields to assign (camelCase/snake_case, matching bean property names).
 * @returns {Promise<object>} The stored monitor bean, reloaded from the DB.
 */
async function createMonitor(fields) {
    let bean = R.dispense("monitor");
    bean.import({
        name: "test monitor",
        interval: 20,
        maxretries: 0,
        accepted_statuscodes_json: JSON.stringify(["200-299"]),
        conditions: "[]",
        kafkaProducerBrokers: "[]",
        kafkaProducerSaslOptions: "{}",
        rabbitmqNodes: "[]",
        type: "http",
        url: "https://example.com",
        ...fields,
    });
    await R.store(bean);
    return await R.load("monitor", bean.id);
}

/**
 * Create a second team ("Team B") with its own owner-role membership for a
 * given user, using the real seeded role templates (team_id NULL) written by
 * the RBAC migration. Mirrors what a later "create team" flow would insert.
 * @param {string} slug Unique slug for the new team.
 * @param {number} userId The user to make an owner member of the new team.
 * @returns {Promise<number>} The new team's id.
 */
async function createTeamWithOwner(slug, userId) {
    const [teamId] = await R.knex("team").insert({ name: slug, slug, is_system: 0, active: 1 });
    const ownerRole = await R.knex("role").whereNull("team_id").andWhere("slug", "owner").first();
    await R.knex("team_user").insert({ team_id: teamId, user_id: userId, role_id: ownerRole.id });
    return teamId;
}

describe("monitor-socket-handler authz retrofit (P3)", () => {
    const testDb = new TestDB("./data/test-monitor-socket-authz");

    let userA;
    let userB;
    let teamAId;
    let teamBId;

    before(async () => {
        await testDb.create();

        // The RBAC migration backfills a Default Team and makes the
        // lowest-id existing user its superadmin/owner. Create two fresh,
        // non-superadmin users and their own teams for a real two-team scenario.
        const [uAId] = await R.knex("user").insert({
            username: "authz-user-a",
            password: "x",
            active: 1,
            is_superadmin: 0,
        });
        const [uBId] = await R.knex("user").insert({
            username: "authz-user-b",
            password: "x",
            active: 1,
            is_superadmin: 0,
        });
        userA = await R.knex("user").where("id", uAId).first();
        userB = await R.knex("user").where("id", uBId).first();

        teamAId = await createTeamWithOwner("team-a-authz", userA.id);
        teamBId = await createTeamWithOwner("team-b-authz", userB.id);
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    afterEach(() => {
        // Every test must leave enforcement OFF for the next one (and for any
        // other suite running in the same process).
        setEnforcementEnabled(false);
    });

    describe("enforcement OFF (dark-launch default): existing handler behaviour is unchanged", () => {
        test("requireResource is a true no-op: never throws, never queries teamIdLoader", async () => {
            assert.strictEqual(setEnforcementEnabled === undefined, false);
            let loaderCalled = false;
            const spyLoader = async (...args) => {
                loaderCalled = true;
                return teamIdLoader(...args);
            };

            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const actorless = null; // afterLogin's catch-path can leave socket.actor null

            await requireResource(actorless, "monitor:read", "monitor", monitor.id, spyLoader);
            await requireResource(actorless, "monitor:delete", "monitor", monitor.id, spyLoader);

            assert.strictEqual(loaderCalled, false, "the loader must never be called while enforcement is OFF");
        });

        test("getMonitor handler path: WHERE id=? AND user_id=? is unchanged and still the sole gate", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const actorB = await buildActorForUser(userB);

            // Simulate the retrofitted handler body: requireResource first (should
            // be a no-op even though actorB is not a member of Team A), then the
            // pre-existing per-user WHERE clause exactly as before.
            await requireResource(actorB, "monitor:read", "monitor", monitor.id, teamIdLoader);
            const rowForB = await R.findOne("monitor", " id = ? AND user_id = ? ", [monitor.id, userB.id]);
            assert.strictEqual(rowForB, null, "legacy per-user filter still denies user B (unchanged behaviour)");

            const rowForA = await R.findOne("monitor", " id = ? AND user_id = ? ", [monitor.id, userA.id]);
            assert.ok(rowForA, "legacy per-user filter still allows the owning user (unchanged behaviour)");
        });

        test("validateMonitorLinkedResources-equivalent calls do not throw for a cross-team docker_host id", async () => {
            const [dockerHostId] = await R.knex("docker_host").insert({
                user_id: userB.id,
                team_id: teamBId,
                docker_daemon: "unix:///var/run/docker.sock",
                docker_type: "socket",
                name: "team-b-docker-host",
            });
            const actorA = await buildActorForUser(userA);

            // Team A's actor referencing Team B's docker host must not throw while OFF.
            await requireResource(actorA, "docker_host:read", "docker_host", dockerHostId, teamIdLoader);
        });

        test("scopeFilter still returns the legacy byte-identical 'user_id = ?' filter", async () => {
            const actorA = await buildActorForUser(userA);
            const filter = scopeFilter(actorA);
            assert.strictEqual(filter.clause, "user_id = ?");
            assert.deepStrictEqual(filter.params, [actorA.userId]);
        });
    });

    describe("enforcement ON (test-only): real two-team denial through the actual authz call sites", () => {
        beforeEach(() => setEnforcementEnabled(true));
        afterEach(() => setEnforcementEnabled(false));

        test("requireResource(monitor:read) denies an actor from Team B on a Team A monitor", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const actorB = await buildActorForUser(userB);

            await assert.rejects(
                requireResource(actorB, "monitor:read", "monitor", monitor.id, teamIdLoader),
                ForbiddenError
            );
        });

        test("requireResource(monitor:read) allows the owning team's actor", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const actorA = await buildActorForUser(userA);

            await assert.doesNotReject(requireResource(actorA, "monitor:read", "monitor", monitor.id, teamIdLoader));
        });

        test("requireResource(monitor:delete) denies deleting a Team A monitor as Team B (deleteMonitor gate)", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const actorB = await buildActorForUser(userB);

            await assert.rejects(
                requireResource(actorB, "monitor:delete", "monitor", monitor.id, teamIdLoader),
                ForbiddenError
            );

            // Prove the resource genuinely survives: the (unchanged) model-level
            // delete call is never reached because the socket-handler-level gate
            // throws first in the real handler flow.
            const stillThere = await R.findOne("monitor", " id = ? ", [monitor.id]);
            assert.ok(stillThere, "monitor must still exist — denial happens before Monitor.deleteMonitor runs");
        });

        test("requireResource(tag:manage) denies editing/deleting a Team A tag as Team B (editTag/deleteTag gate)", async () => {
            const [tagId] = await R.knex("tag").insert({ name: "team-a-tag", color: "#fff", team_id: teamAId });
            const actorB = await buildActorForUser(userB);
            const actorA = await buildActorForUser(userA);

            await assert.rejects(requireResource(actorB, "tag:manage", "tag", tagId, teamIdLoader), ForbiddenError);
            await assert.doesNotReject(requireResource(actorA, "tag:manage", "tag", tagId, teamIdLoader));
        });

        test("requireResource(monitor:update) denies tagging a Team A monitor as Team B (addMonitorTag/editMonitorTag/deleteMonitorTag gate)", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const actorB = await buildActorForUser(userB);

            await assert.rejects(
                requireResource(actorB, "monitor:update", "monitor", monitor.id, teamIdLoader),
                ForbiddenError
            );
        });

        test("requireResource(monitor:read) denies reading a Team A monitor's beats as Team B (getMonitorBeats gate)", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const actorB = await buildActorForUser(userB);

            await assert.rejects(
                requireResource(actorB, "monitor:read", "monitor", monitor.id, teamIdLoader),
                ForbiddenError
            );
        });

        test("FK cross-resource validation: Team B actor referencing a Team A docker_host/proxy/remote_browser/parent monitor is denied", async () => {
            const [dockerHostId] = await R.knex("docker_host").insert({
                user_id: userA.id,
                team_id: teamAId,
                docker_daemon: "unix:///var/run/docker.sock",
                docker_type: "socket",
                name: "team-a-docker-host",
            });
            const [proxyId] = await R.knex("proxy").insert({
                user_id: userA.id,
                team_id: teamAId,
                protocol: "http",
                host: "proxy.example.com",
                port: 8080,
                auth: 0,
            });
            const [remoteBrowserId] = await R.knex("remote_browser").insert({
                user_id: userA.id,
                team_id: teamAId,
                name: "team-a-browser",
                url: "ws://example.com",
            });
            const parentMonitor = await createMonitor({ user_id: userA.id, team_id: teamAId, type: "group" });

            const actorB = await buildActorForUser(userB);

            await assert.rejects(
                requireResource(actorB, "docker_host:read", "docker_host", dockerHostId, teamIdLoader),
                ForbiddenError,
                "docker_host cross-team reference must be denied"
            );
            await assert.rejects(
                requireResource(actorB, "proxy:read", "proxy", proxyId, teamIdLoader),
                ForbiddenError,
                "proxy cross-team reference must be denied"
            );
            await assert.rejects(
                requireResource(actorB, "remote_browser:read", "remote_browser", remoteBrowserId, teamIdLoader),
                ForbiddenError,
                "remote_browser cross-team reference must be denied"
            );
            await assert.rejects(
                requireResource(actorB, "monitor:read", "monitor", parentMonitor.id, teamIdLoader),
                ForbiddenError,
                "parent monitor (group) cross-team reference must be denied"
            );

            // And the owning team's actor is allowed through all four.
            const actorA = await buildActorForUser(userA);
            await assert.doesNotReject(
                requireResource(actorA, "docker_host:read", "docker_host", dockerHostId, teamIdLoader)
            );
            await assert.doesNotReject(requireResource(actorA, "proxy:read", "proxy", proxyId, teamIdLoader));
            await assert.doesNotReject(
                requireResource(actorA, "remote_browser:read", "remote_browser", remoteBrowserId, teamIdLoader)
            );
            await assert.doesNotReject(
                requireResource(actorA, "monitor:read", "monitor", parentMonitor.id, teamIdLoader)
            );
        });

        test("scopeFilter scopes a list query to only the actor's own team(s), excluding a cross-team monitor", async () => {
            const monitorA = await createMonitor({ user_id: userA.id, team_id: teamAId });
            await createMonitor({ user_id: userB.id, team_id: teamBId });
            const actorA = await buildActorForUser(userA);

            const filter = scopeFilter(actorA);
            const rows = await R.find("monitor", filter.clause, filter.params);
            const ids = rows.map((r) => r.id);

            assert.ok(ids.includes(monitorA.id), "Team A's own monitor is visible");
            const teamBMonitors = await R.find("monitor", " team_id = ? ", [teamBId]);
            for (const m of teamBMonitors) {
                assert.ok(!ids.includes(m.id), "Team B's monitors must not leak into Team A's scoped list");
            }
        });
    });

    // -------------------------------------------------------------------
    // Real handler invocations (not authz.js in isolation): drives the actual
    // monitorSocketHandler via a mock socket + trigger(), proving the
    // retrofit is genuinely wired into getMonitor/getMonitorBeats/deleteMonitor.
    // -------------------------------------------------------------------
    describe("through the real monitorSocketHandler (enforcement OFF)", () => {
        test("getMonitor still succeeds via the legacy user_id predicate, even with a cross-team actor attached", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const socket = createMockSocket(userA.id, await buildActorForUser(userB));
            monitorSocketHandler(socket, createStubServer(), {});

            const result = await socket.trigger("getMonitor", monitor.id);
            assert.strictEqual(result.ok, true, "requireResource must not block this while enforcement is OFF");
            assert.strictEqual(result.monitor.id, monitor.id);
        });

        test("deleteMonitor still no-ops safely (no throw) with a null actor", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const socket = createMockSocket(userA.id, null);
            monitorSocketHandler(socket, createStubServer(), {});

            const result = await socket.trigger("deleteMonitor", monitor.id, false);
            assert.strictEqual(
                result.ok,
                true,
                "requireResource must be a true no-op while OFF, even with a null actor"
            );

            const gone = await R.findOne("monitor", " id = ? ", [monitor.id]);
            assert.strictEqual(gone, null, "deletion itself must have proceeded normally");
        });
    });

    describe("through the real monitorSocketHandler (enforcement ON, two-team isolation)", () => {
        // beforeEach (not before): the outer describe's own afterEach resets
        // enforcement to OFF after every single test, including these, so it
        // must be re-enabled before each one, not just once at the start.
        beforeEach(() => setEnforcementEnabled(true));
        afterEach(() => setEnforcementEnabled(false));

        test("getMonitor denies a Team B actor reading a Team A monitor", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const socket = createMockSocket(userB.id, await buildActorForUser(userB));
            monitorSocketHandler(socket, createStubServer(), {});

            const result = await socket.trigger("getMonitor", monitor.id);
            assert.strictEqual(result.ok, false, "cross-team read must be denied");
            assert.ok(result.msg.includes("Permission denied"), `expected ForbiddenError message, got: ${result.msg}`);
        });

        test("getMonitor allows a Team A actor to read its own monitor", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const socket = createMockSocket(userA.id, await buildActorForUser(userA));
            monitorSocketHandler(socket, createStubServer(), {});

            const result = await socket.trigger("getMonitor", monitor.id);
            assert.strictEqual(result.ok, true, "same-team read must be allowed");
            assert.strictEqual(result.monitor.id, monitor.id);
        });

        test("getMonitorBeats denies a Team B actor reading a Team A monitor's heartbeats", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const socket = createMockSocket(userB.id, await buildActorForUser(userB));
            monitorSocketHandler(socket, createStubServer(), {});

            const result = await socket.trigger("getMonitorBeats", monitor.id, 24);
            assert.strictEqual(result.ok, false, "cross-team beats read must be denied");
            assert.ok(result.msg.includes("Permission denied"), `expected ForbiddenError message, got: ${result.msg}`);
        });

        test("deleteMonitor denies a Team B actor deleting a Team A monitor (row survives)", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const socket = createMockSocket(userB.id, await buildActorForUser(userB));
            monitorSocketHandler(socket, createStubServer(), {});

            const result = await socket.trigger("deleteMonitor", monitor.id, false);
            assert.strictEqual(result.ok, false, "cross-team delete must be denied");
            assert.ok(result.msg.includes("Permission denied"), `expected ForbiddenError message, got: ${result.msg}`);

            const stillThere = await R.findOne("monitor", " id = ? ", [monitor.id]);
            assert.ok(stillThere, "monitor row must survive a denied cross-team delete");
        });

        test("deleteMonitor allows a Team A actor to delete its own monitor", async () => {
            const monitor = await createMonitor({ user_id: userA.id, team_id: teamAId });
            const socket = createMockSocket(userA.id, await buildActorForUser(userA));
            monitorSocketHandler(socket, createStubServer(), {});

            const result = await socket.trigger("deleteMonitor", monitor.id, false);
            assert.strictEqual(result.ok, true, "same-team delete must be allowed");

            const gone = await R.findOne("monitor", " id = ? ", [monitor.id]);
            assert.strictEqual(gone, null);
        });
    });
});
