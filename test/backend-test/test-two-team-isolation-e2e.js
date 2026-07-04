process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { setEnforcementEnabled } = require("../../server/security/authz");
const { buildActorForUser } = require("../../server/security/actor-repository");
const { roomFor } = require("../../server/security/rooms");
const { UptimeKumaServer } = require("../../server/uptime-kuma-server");
const { monitorSocketHandler } = require("../../server/socket-handlers/monitor-socket-handler");
const { maintenanceSocketHandler } = require("../../server/socket-handlers/maintenance-socket-handler");
const { statusPageSocketHandler } = require("../../server/socket-handlers/status-page-socket-handler");
const ioClient = require("socket.io-client");

/**
 * ADR-0010's stated P4 deliverable is a "Fixture E2E 2-teams" proving the
 * flip works end-to-end, not just gate-by-gate. Monitor/maintenance/status-page
 * authz and the room-routing retrofit each already have deep dedicated test
 * files; this one instead ties them together in a single continuous two-team
 * narrative -- one pair of real, DB-backed actors (via buildActorForUser, not
 * hand-built via buildActor()) exercised across all three core resource types
 * AND the real Socket.io delivery layer, to catch bugs that hide in the seams
 * between systems rather than within any single gate.
 */

/**
 * Build a mock socket.io-like object that captures registered "on" handlers
 * so socket handler logic can be invoked directly, without a real socket.io
 * connection. Mirrors the helper used across the other authz test files.
 * @param {number} userID Fake logged-in user id to attach to the mock socket
 * @param {object} actor The RBAC actor to attach as socket.actor
 * @returns {{userID: number, actor: object, on: Function, trigger: Function}} Mock socket
 */
function createMockSocket(userID, actor) {
    const handlers = {};
    return {
        userID,
        actor,
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
 * Minimal stub of the "server" object monitorSocketHandler's getMonitor code
 * path calls methods on. Mirrors the helper used in test-monitor-socket-authz.js.
 * @returns {object} A stub server exposing no-op async methods.
 */
function createStubServer() {
    return {
        sendDeleteMonitorFromList: async () => {},
        sendUpdateMonitorIntoList: async () => {},
    };
}

/**
 * Look up a built-in role's id (team_id NULL global template) by slug.
 * @param {string} slug Role slug, e.g. "owner".
 * @returns {Promise<number>} The role id.
 */
async function getBuiltinRoleId(slug) {
    const role = await R.getRow("SELECT id FROM `role` WHERE team_id IS NULL AND slug = ?", [slug]);
    return role.id;
}

describe("Two-team isolation, end-to-end (ADR-0010 P4 capstone fixture)", () => {
    const testDb = new TestDB("./data/test-two-team-isolation-e2e");

    let alice;
    let bob;
    let teamAlphaId;
    let teamBetaId;
    let monitorAlpha;
    let maintenanceAlphaId;
    let statusPageAlpha;

    before(async () => {
        await testDb.create();

        const [aliceId] = await R.knex("user").insert({
            username: "e2e-alice",
            password: "x",
            active: 1,
            is_superadmin: 0,
        });
        const [bobId] = await R.knex("user").insert({
            username: "e2e-bob",
            password: "x",
            active: 1,
            is_superadmin: 0,
        });
        alice = await R.knex("user").where("id", aliceId).first();
        bob = await R.knex("user").where("id", bobId).first();

        const [alphaId] = await R.knex("team").insert({
            name: "Team Alpha",
            slug: "e2e-team-alpha",
            is_system: 0,
            active: 1,
        });
        const [betaId] = await R.knex("team").insert({
            name: "Team Beta",
            slug: "e2e-team-beta",
            is_system: 0,
            active: 1,
        });
        teamAlphaId = alphaId;
        teamBetaId = betaId;

        const ownerRoleId = await getBuiltinRoleId("owner");
        await R.knex("team_user").insert({ team_id: teamAlphaId, user_id: alice.id, role_id: ownerRoleId });
        await R.knex("team_user").insert({ team_id: teamBetaId, user_id: bob.id, role_id: ownerRoleId });

        // One resource of each core team-scoped type, all owned by Alice/Team Alpha.
        const monitorBean = R.dispense("monitor");
        monitorBean.import({
            name: "e2e alpha monitor",
            interval: 20,
            maxretries: 0,
            accepted_statuscodes_json: JSON.stringify(["200-299"]),
            conditions: "[]",
            kafkaProducerBrokers: "[]",
            kafkaProducerSaslOptions: "{}",
            rabbitmqNodes: "[]",
            type: "push",
            user_id: alice.id,
            team_id: teamAlphaId,
        });
        await R.store(monitorBean);
        monitorAlpha = await R.load("monitor", monitorBean.id);

        const maintenanceBean = R.dispense("maintenance");
        maintenanceBean.title = "e2e alpha maintenance";
        maintenanceBean.description = "test maintenance window";
        maintenanceBean.user_id = alice.id;
        maintenanceBean.team_id = teamAlphaId;
        maintenanceBean.strategy = "manual";
        maintenanceBean.active = true;
        maintenanceAlphaId = await R.store(maintenanceBean);

        const statusPageBean = R.dispense("status_page");
        statusPageBean.slug = "e2e-alpha-status";
        statusPageBean.title = "E2E Alpha Status";
        statusPageBean.theme = "auto";
        statusPageBean.icon = "";
        statusPageBean.autoRefreshInterval = 300;
        statusPageBean.team_id = teamAlphaId;
        await R.store(statusPageBean);
        statusPageAlpha = statusPageBean;
    });

    after(async () => {
        Settings.stopCacheCleaner();
        setEnforcementEnabled(false);
        await testDb.destroy();
    });

    describe("enforcement OFF (dark-launch default): legacy behaviour is exactly preserved", () => {
        test("Bob's legacy per-user query still can't see Alice's monitor -- unrelated to RBAC, unchanged", async () => {
            const row = await R.findOne("monitor", " id = ? AND user_id = ? ", [monitorAlpha.id, bob.id]);
            assert.strictEqual(row, null);
        });
    });

    describe("enforcement ON: cross-team denial across all 3 core resource types, through the real handlers", () => {
        before(() => setEnforcementEnabled(true));
        after(() => setEnforcementEnabled(false));

        test("Bob (Team Beta) is denied reading every one of Alice's (Team Alpha) resources", async () => {
            const bobActor = await buildActorForUser(bob);

            const monitorSocket = createMockSocket(bob.id, bobActor);
            monitorSocketHandler(monitorSocket, createStubServer(), {});
            const monitorResult = await monitorSocket.trigger("getMonitor", monitorAlpha.id);
            assert.strictEqual(monitorResult.ok, false, "monitor read must be denied");

            const maintenanceSocket = createMockSocket(bob.id, bobActor);
            maintenanceSocketHandler(maintenanceSocket);
            const maintenanceResult = await maintenanceSocket.trigger("getMaintenance", maintenanceAlphaId);
            assert.strictEqual(maintenanceResult.ok, false, "maintenance read must be denied");

            const statusPageSocket = createMockSocket(bob.id, bobActor);
            statusPageSocketHandler(statusPageSocket);
            const statusPageResult = await statusPageSocket.trigger("getStatusPage", statusPageAlpha.slug);
            assert.strictEqual(statusPageResult.ok, false, "status page read must be denied");
        });

        test("Alice (Team Alpha) can read every one of her own resources", async () => {
            const aliceActor = await buildActorForUser(alice);

            const monitorSocket = createMockSocket(alice.id, aliceActor);
            monitorSocketHandler(monitorSocket, createStubServer(), {});
            const monitorResult = await monitorSocket.trigger("getMonitor", monitorAlpha.id);
            assert.strictEqual(monitorResult.ok, true, "monitor read must be allowed");

            const maintenanceSocket = createMockSocket(alice.id, aliceActor);
            maintenanceSocketHandler(maintenanceSocket);
            const maintenanceResult = await maintenanceSocket.trigger("getMaintenance", maintenanceAlphaId);
            assert.strictEqual(maintenanceResult.ok, true, "maintenance read must be allowed");

            const statusPageSocket = createMockSocket(alice.id, aliceActor);
            statusPageSocketHandler(statusPageSocket);
            const statusPageResult = await statusPageSocket.trigger("getStatusPage", statusPageAlpha.slug);
            assert.strictEqual(statusPageResult.ok, true, "status page read must be allowed");
        });

        test("list scoping: Bob sees zero monitors, Alice sees exactly her own, via the real getMonitorJSONList", async () => {
            const server = UptimeKumaServer.getInstance();
            const bobActor = await buildActorForUser(bob);
            const aliceActor = await buildActorForUser(alice);

            const bobList = await server.getMonitorJSONList(bobActor);
            assert.deepStrictEqual(Object.keys(bobList), []);

            const aliceList = await server.getMonitorJSONList(aliceActor);
            assert.deepStrictEqual(Object.keys(aliceList).map(Number), [monitorAlpha.id]);
        });
    });

    describe("enforcement ON: real Socket.io room delivery isolates the two teams", () => {
        let server;
        let port;

        before(async () => {
            setEnforcementEnabled(true);
            server = UptimeKumaServer.getInstance();
            server.io.on("connection", (socket) => {
                const q = socket.handshake.query;
                socket.join(roomFor(Number(q.userId), q.teamId ? Number(q.teamId) : null));
            });
            await new Promise((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
            port = server.httpServer.address().port;
        });

        after(async () => {
            server.io.removeAllListeners("connection");
            setEnforcementEnabled(false);
            await new Promise((resolve) => server.httpServer.close(resolve));
        });

        /**
         * Connect a real socket.io-client socket, joining a room server-side
         * based on the query params. The team id passed in is always the real,
         * DB-derived actor's activeTeamId -- not a synthetic value -- so the
         * room this socket ends up in matches exactly what afterLogin's
         * post-actor-resolution roomFor(...) join would produce.
         * @param {number} userId Legacy user id to join with
         * @param {number} activeTeamId The real actor's active team id
         * @returns {Promise<object>} The connected client socket
         */
        function connectAs(userId, activeTeamId) {
            return new Promise((resolve, reject) => {
                const client = ioClient(`http://127.0.0.1:${port}`, {
                    query: { userId: String(userId), teamId: String(activeTeamId) },
                    transports: ["websocket"],
                    reconnection: false,
                });
                client.once("connect", () => resolve(client));
                client.once("connect_error", reject);
            });
        }

        test("a monitorList update to Team Alpha's room reaches Alice's socket, not Bob's", async () => {
            const aliceActor = await buildActorForUser(alice);
            const bobActor = await buildActorForUser(bob);

            const aliceClient = await connectAs(alice.id, aliceActor.activeTeamId);
            const bobClient = await connectAs(bob.id, bobActor.activeTeamId);
            try {
                const aliceReceived = new Promise((resolve) => aliceClient.once("monitorList", resolve));
                let bobReceived = false;
                bobClient.once("monitorList", () => {
                    bobReceived = true;
                });

                server.io.to(roomFor(alice.id, aliceActor.activeTeamId)).emit("monitorList", { [monitorAlpha.id]: {} });

                await aliceReceived;
                await new Promise((resolve) => setTimeout(resolve, 200));
                assert.strictEqual(bobReceived, false, "Team Beta must not receive Team Alpha's real-time update");
            } finally {
                aliceClient.close();
                bobClient.close();
            }
        });
    });
});
