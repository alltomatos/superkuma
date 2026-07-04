process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");

// See test-federation-heartbeat.js for why these dayjs plugins are required
// up front: the federation-router pipeline (via Monitor.sendNotification())
// depends on them being registered, exactly like server.js does at boot.
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

const { Settings } = require("../../server/settings");
const { remoteInstanceSocketHandler } = require("../../server/socket-handlers/remote-instance-socket-handler");
const federationRouter = require("../../server/routers/federation-router");
const { forwardHeartbeatToMaster } = require("../../server/federation/agent-forwarder");
const { UP, DOWN, PENDING, MAINTENANCE } = require("../../src/util");

const testDb = new TestDB("./data/test-federation-forwarder");

/**
 * Build a mock socket.io-like object that captures registered "on" handlers
 * so socket handler logic can be invoked directly, without a real socket.io
 * connection. Mirrors test-federation-heartbeat.js's harness exactly.
 * @param {number} userID Fake logged-in user id to attach to the mock socket
 * @returns {{userID: number, on: Function, trigger: Function}} Mock socket
 */
function createMockSocket(userID) {
    const handlers = {};
    return {
        userID,
        on(event, handler) {
            handlers[event] = handler;
        },
        /**
         * Invoke a previously-registered handler by event name
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
 * Register a new remote instance via the real socket handler logic and
 * return its formatted one-time token.
 * @param {number} userID User id to register the instance under
 * @param {string} instanceId Agent-chosen unique instance identifier
 * @param {string} name Human-readable instance name
 * @returns {Promise<{token: string, remoteInstanceID: number}>} Registration result
 */
async function registerRemoteInstance(userID, instanceId, name) {
    const socket = createMockSocket(userID);
    remoteInstanceSocketHandler(socket);

    const result = await socket.trigger("addRemoteInstance", {
        name,
        instanceId,
    });

    if (!result.ok) {
        throw new Error(`addRemoteInstance failed: ${result.msg}`);
    }

    return {
        token: result.token,
        remoteInstanceID: result.remoteInstanceID,
    };
}

/**
 * Build a minimal fake local monitor object -- just enough of the shape
 * `forwardHeartbeatToMaster` reads (id/name/type) to stand in for a real
 * `Monitor` bean without booting the whole model layer.
 * @param {number} id Local (agent-side) monitor id
 * @param {string} name Monitor name
 * @param {string} type Monitor type
 * @returns {{id: number, name: string, type: string}} Fake monitor
 */
function fakeMonitor(id, name, type = "http") {
    return { id, name, type };
}

/**
 * Build a minimal fake heartbeat bean -- just enough of the shape
 * `forwardHeartbeatToMaster` reads (status/msg/ping).
 * @param {number} status Numeric status constant (UP/DOWN/PENDING/MAINTENANCE)
 * @param {string} msg Heartbeat message
 * @param {?number} ping Ping value in ms, or null
 * @returns {{status: number, msg: string, ping: (number|null)}} Fake heartbeat bean
 */
function fakeBean(status, msg = "", ping = null) {
    return { status, msg, ping };
}

describe("Federation Agent Forwarder (F2)", () => {
    let httpServer;
    let masterPort;
    let userID;

    before(async () => {
        await testDb.create();

        // Real user row (remote_instance.user_id references user.id), representing
        // the Master's own database -- this whole test process plays both the
        // "fake Master" (real Express app + real federation-router + real DB)
        // and the "Agent" (calling forwardHeartbeatToMaster directly) roles.
        let userBean = R.dispense("user");
        userBean.username = "federation-forwarder-test-user";
        userBean.password = "not-a-real-hash";
        userBean.active = true;
        userID = await R.store(userBean);

        // Real HTTP server hosting only the federation router -- this is the
        // fake Master the Agent-side forwarder will POST to over a genuine
        // HTTP round trip on an ephemeral port.
        const app = express();
        app.use(express.json());
        app.use(federationRouter);

        httpServer = http.createServer(app);
        await new Promise((resolve) => {
            httpServer.listen(0, "127.0.0.1", resolve);
        });
        masterPort = httpServer.address().port;
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await new Promise((resolve) => httpServer.close(resolve));
        await testDb.destroy();
    });

    beforeEach(async () => {
        // Ensure no config leaks between tests (each test sets exactly what
        // it needs) and the settings cache doesn't serve stale values.
        await Settings.set("federationMasterUrl", null);
        await Settings.set("federationToken", null);
        await Settings.set("federationInstanceId", null);
    });

    /**
     * Configure the three federation Agent settings via the exact generic
     * `Settings.set` mechanism described in the task (no new socket handler).
     * @param {string} masterUrl Base URL of the fake Master
     * @param {string} token Bearer token (ri<id>_<secret>) for the fake Master
     * @param {string} instanceId The instanceId matching the token's registration
     * @returns {Promise<void>} Resolves once all three settings are persisted
     */
    async function configureFederation(masterUrl, token, instanceId) {
        await Settings.set("federationMasterUrl", masterUrl);
        await Settings.set("federationToken", token);
        await Settings.set("federationInstanceId", instanceId);
    }

    test("successful forward creates exactly one mirrored monitor + one heartbeat on the fake Master", async () => {
        const { token } = await registerRemoteInstance(userID, "agent-success", "Agent Success");
        await configureFederation(`http://127.0.0.1:${masterPort}`, token, "agent-success");

        const monitor = fakeMonitor(101, "My Local Service", "http");
        const bean = fakeBean(UP, "OK", 42);

        await forwardHeartbeatToMaster(monitor, bean);

        const remoteInstance = await R.findOne("remote_instance", " instance_id = ? ", ["agent-success"]);
        const monitors = await R.find("monitor", " remote_instance_id = ? AND remote_monitor_id = ? ", [
            remoteInstance.id,
            "101",
        ]);

        assert.strictEqual(monitors.length, 1, "exactly one mirrored monitor should be created");
        assert.strictEqual(monitors[0].type, "push");
        assert.strictEqual(monitors[0].remote_instance_id, remoteInstance.id);
        assert.strictEqual(monitors[0].remote_monitor_id, "101");
        assert.ok(monitors[0].name.includes("My Local Service"));

        const heartbeats = await R.find("heartbeat", " monitor_id = ? ", [monitors[0].id]);
        assert.strictEqual(heartbeats.length, 1, "exactly one heartbeat should be stored");
        assert.strictEqual(heartbeats[0].status, 1, "status should be UP (1)");
    });

    test("a second forward for the same agentMonitorId updates the SAME mirrored monitor (idempotent)", async () => {
        const { token } = await registerRemoteInstance(userID, "agent-idempotent", "Agent Idempotent");
        await configureFederation(`http://127.0.0.1:${masterPort}`, token, "agent-idempotent");

        const monitor = fakeMonitor(202, "Shared Local Service", "http");

        await forwardHeartbeatToMaster(monitor, fakeBean(UP, "OK", 10));
        await forwardHeartbeatToMaster(monitor, fakeBean(DOWN, "Connection refused", null));

        const remoteInstance = await R.findOne("remote_instance", " instance_id = ? ", ["agent-idempotent"]);
        const monitors = await R.find("monitor", " remote_instance_id = ? AND remote_monitor_id = ? ", [
            remoteInstance.id,
            "202",
        ]);

        assert.strictEqual(monitors.length, 1, "exactly one mirrored monitor must exist -- no duplicate created");

        const heartbeats = await R.find("heartbeat", " monitor_id = ? ORDER BY id ASC", [monitors[0].id]);
        assert.strictEqual(heartbeats.length, 2, "two heartbeats should be stored against the same monitor");
        assert.strictEqual(heartbeats[0].status, 1, "first heartbeat should be UP");
        assert.strictEqual(heartbeats[1].status, 0, "second heartbeat should be DOWN");
    });

    test("missing config is a silent no-op: no throw, no network call", async () => {
        // All three settings are cleared by beforeEach -- nothing configured.
        const monitor = fakeMonitor(303, "Unconfigured Service", "http");

        await assert.doesNotReject(async () => {
            await forwardHeartbeatToMaster(monitor, fakeBean(UP, "OK", 5));
        });

        // No remote_instance was ever registered for this test, so if a
        // monitor with remote_monitor_id "303" existed, it could only have
        // come from an unexpected network call reaching the fake Master.
        const monitors = await R.find("monitor", " remote_monitor_id = ? ", ["303"]);
        assert.strictEqual(monitors.length, 0, "no request should have reached the fake Master");
    });

    test("partial config (only some of the 3 keys set) is also a silent no-op", async () => {
        await Settings.set("federationMasterUrl", `http://127.0.0.1:${masterPort}`);
        // token and instanceId left unset

        const monitor = fakeMonitor(304, "Partially Configured Service", "http");

        await assert.doesNotReject(async () => {
            await forwardHeartbeatToMaster(monitor, fakeBean(UP, "OK", 5));
        });

        const monitors = await R.find("monitor", " remote_monitor_id = ? ", ["304"]);
        assert.strictEqual(monitors.length, 0, "no request should have reached the fake Master");
    });

    test("resilience: unreachable Master (nothing listening) resolves normally, does not throw or hang", async () => {
        // Port 1 is a reserved/unroutable port that (practically) never has a
        // listener bound in any test environment -- connection is refused
        // quickly, exercising the network-error branch of the try/catch.
        await configureFederation("http://127.0.0.1:1", "ri1_bogus-secret-for-dead-master", "agent-dead-master");

        const monitor = fakeMonitor(404, "Doomed Service", "http");

        const start = Date.now();
        await assert.doesNotReject(async () => {
            await forwardHeartbeatToMaster(monitor, fakeBean(DOWN, "Connection refused", null));
        });
        const elapsedMs = Date.now() - start;

        // Must not hang anywhere near the 10s configured timeout -- a refused
        // connection should fail almost immediately.
        assert.ok(elapsedMs < 9000, `forwardHeartbeatToMaster took too long against a dead Master: ${elapsedMs}ms`);
    });

    test("resilience: wrong token against a live fake Master resolves normally, does not throw", async () => {
        // Register a real instance so the Master is legitimately reachable,
        // but deliberately use a bogus token so verifyRemoteInstanceToken
        // rejects the request (401) -- the forwarder must swallow this too.
        await registerRemoteInstance(userID, "agent-wrong-token", "Agent Wrong Token");
        await configureFederation(`http://127.0.0.1:${masterPort}`, "ri999999_totally-wrong-secret", "agent-wrong-token");

        const monitor = fakeMonitor(505, "Wrong Token Service", "http");

        await assert.doesNotReject(async () => {
            await forwardHeartbeatToMaster(monitor, fakeBean(UP, "OK", 5));
        });

        const monitors = await R.find("monitor", " remote_monitor_id = ? ", ["505"]);
        assert.strictEqual(monitors.length, 0, "no monitor should be mirrored when auth fails");
    });

    test("PENDING and MAINTENANCE beats are skipped -- no network call made, no monitor created", async () => {
        const { token } = await registerRemoteInstance(userID, "agent-pending-maint", "Agent Pending Maint");
        await configureFederation(`http://127.0.0.1:${masterPort}`, token, "agent-pending-maint");

        const monitor = fakeMonitor(606, "Pending Or Maintenance Service", "http");

        await forwardHeartbeatToMaster(monitor, fakeBean(PENDING, "Pending", null));
        await forwardHeartbeatToMaster(monitor, fakeBean(MAINTENANCE, "Under maintenance", null));

        const remoteInstance = await R.findOne("remote_instance", " instance_id = ? ", ["agent-pending-maint"]);
        const monitors = await R.find("monitor", " remote_instance_id = ? AND remote_monitor_id = ? ", [
            remoteInstance.id,
            "606",
        ]);

        assert.strictEqual(monitors.length, 0, "PENDING/MAINTENANCE beats must not be forwarded to the Master");
    });
});
