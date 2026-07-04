process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");

// server.js normally registers these dayjs plugins once at boot. This test
// requires server/routers/federation-router.js directly (without booting
// the full server.js), but the heartbeat pipeline it exercises -- via
// Monitor.sendNotification()'s use of dayjs.utc().tz() -- depends on them,
// exactly like the existing /api/push handler does.
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

const { Settings } = require("../../server/settings");
const { verifyRemoteInstanceToken } = require("../../server/auth");
const { remoteInstanceSocketHandler } = require("../../server/socket-handlers/remote-instance-socket-handler");
const federationRouter = require("../../server/routers/federation-router");

const testDb = new TestDB("./data/test-federation-heartbeat");

/**
 * Build a mock socket.io-like object that captures registered "on" handlers
 * so socket handler logic can be invoked directly, without a real socket.io
 * connection.
 * @param {number} userID Fake logged-in user id to attach to the mock socket
 * @param {object} actor Optional RBAC actor to attach as socket.actor
 * @returns {{userID: number, actor: object|undefined, on: Function, trigger: Function}} Mock socket
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
 * @param {object} actor Optional RBAC actor to attach to the registering socket
 * @returns {Promise<{token: string, remoteInstanceID: number}>} Registration result
 */
async function registerRemoteInstance(userID, instanceId, name, actor) {
    const socket = createMockSocket(userID, actor);
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
 * Send a JSON POST request to a listening local server and resolve with the
 * parsed response body and status code.
 * @param {number} port Port the test server is listening on
 * @param {string} path Request path
 * @param {object} body JSON-serializable body
 * @param {object} headers Extra headers to send
 * @returns {Promise<{status: number, body: object}>} Parsed response
 */
function postJson(port, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const request = http.request(
            {
                hostname: "127.0.0.1",
                port,
                path,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                    ...headers,
                },
            },
            (response) => {
                let raw = "";
                response.on("data", (chunk) => (raw += chunk));
                response.on("end", () => {
                    let parsed;
                    try {
                        parsed = raw ? JSON.parse(raw) : {};
                    } catch (e) {
                        parsed = { raw };
                    }
                    resolve({
                        status: response.statusCode,
                        body: parsed,
                    });
                });
            }
        );
        request.on("error", reject);
        request.write(payload);
        request.end();
    });
}

describe("Federation Heartbeat (F1)", () => {
    let httpServer;
    let port;
    let userID;

    before(async () => {
        await testDb.create();

        // Create a real user row (remote_instance.user_id references user.id).
        let userBean = R.dispense("user");
        userBean.username = "federation-test-user";
        userBean.password = "not-a-real-hash";
        userBean.active = true;
        userID = await R.store(userBean);

        // Real HTTP server hosting only the federation router, so the
        // heartbeat endpoint is exercised with a genuine HTTP round trip
        // (Node's built-in http client) rather than mocked request/response
        // objects -- this is the most reliable way to prove the express
        // route wiring (json body parsing, headers, status codes) actually
        // works end-to-end, and supertest is not a dependency of this repo.
        const app = express();
        app.use(express.json());
        app.use(federationRouter);

        httpServer = http.createServer(app);
        await new Promise((resolve) => {
            httpServer.listen(0, "127.0.0.1", resolve);
        });
        port = httpServer.address().port;
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await new Promise((resolve) => httpServer.close(resolve));
        await testDb.destroy();
    });

    test("registering a remote instance produces a valid token; a tampered token is rejected", async () => {
        const { token, remoteInstanceID } = await registerRemoteInstance(userID, "instance-a", "Agent A");

        assert.ok(token.startsWith("ri" + remoteInstanceID + "_"), "token should be formatted as ri<id>_<secret>");

        const verified = await verifyRemoteInstanceToken(token);
        assert.ok(verified, "valid token should verify");
        assert.strictEqual(verified.id, remoteInstanceID);

        // Tamper with the secret portion of the token
        const tampered = token.slice(0, -1) + (token.slice(-1) === "x" ? "y" : "x");
        const verifiedTampered = await verifyRemoteInstanceToken(tampered);
        assert.strictEqual(verifiedTampered, false, "tampered token must be rejected");
    });

    test("duplicate instanceId registration is rejected", async () => {
        await registerRemoteInstance(userID, "instance-dup", "Agent Dup 1");

        await assert.rejects(async () => {
            await registerRemoteInstance(userID, "instance-dup", "Agent Dup 2");
        }, /already registered/);
    });

    test("a heartbeat with a valid token + new agentMonitorId creates a new mirrored monitor", async () => {
        const { token } = await registerRemoteInstance(userID, "instance-b", "Agent B");

        const { status, body } = await postJson(
            port,
            "/api/federation/heartbeat",
            {
                agentMonitorId: "monitor-1",
                name: "My Service",
                type: "http",
                status: "up",
                msg: "OK",
                ping: 42,
            },
            { Authorization: `Bearer ${token}` }
        );

        assert.strictEqual(status, 200);
        assert.strictEqual(body.ok, true);

        const remoteInstance = await R.findOne("remote_instance", " instance_id = ? ", ["instance-b"]);
        const monitor = await R.findOne("monitor", " remote_instance_id = ? AND remote_monitor_id = ? ", [
            remoteInstance.id,
            "monitor-1",
        ]);

        assert.ok(monitor, "mirrored monitor should have been created");
        assert.strictEqual(monitor.type, "push", "mirrored monitor must always be type push");
        assert.strictEqual(monitor.remote_instance_id, remoteInstance.id);
        assert.strictEqual(monitor.remote_monitor_id, "monitor-1");
        assert.ok(monitor.name.includes("My Service"), "monitor name should include the agent-reported name");
        assert.ok(monitor.name.includes("Agent B"), "monitor name should include the remote instance name");

        const heartbeat = await R.findOne("heartbeat", " monitor_id = ? ", [monitor.id]);
        assert.ok(heartbeat, "a heartbeat row should have been stored");
        assert.strictEqual(heartbeat.status, 1, "status should be UP (1)");
    });

    test("a second heartbeat with the same token + same agentMonitorId updates the SAME mirrored monitor (idempotent upsert)", async () => {
        const { token } = await registerRemoteInstance(userID, "instance-c", "Agent C");

        await postJson(
            port,
            "/api/federation/heartbeat",
            {
                agentMonitorId: "monitor-shared",
                name: "Shared Service",
                type: "http",
                status: "up",
                msg: "OK",
                ping: 10,
            },
            { Authorization: `Bearer ${token}` }
        );

        const { status, body } = await postJson(
            port,
            "/api/federation/heartbeat",
            {
                agentMonitorId: "monitor-shared",
                name: "Shared Service",
                type: "http",
                status: "down",
                msg: "Connection refused",
                ping: null,
            },
            { Authorization: `Bearer ${token}` }
        );

        assert.strictEqual(status, 200);
        assert.strictEqual(body.ok, true);

        const remoteInstance = await R.findOne("remote_instance", " instance_id = ? ", ["instance-c"]);
        const monitors = await R.find("monitor", " remote_instance_id = ? AND remote_monitor_id = ? ", [
            remoteInstance.id,
            "monitor-shared",
        ]);

        assert.strictEqual(monitors.length, 1, "exactly one mirrored monitor must exist -- no duplicate created");

        const heartbeats = await R.find("heartbeat", " monitor_id = ? ORDER BY id ASC", [monitors[0].id]);
        assert.strictEqual(heartbeats.length, 2, "two heartbeats should be stored against the same monitor");
        assert.strictEqual(heartbeats[0].status, 1, "first heartbeat should be UP");
        assert.strictEqual(heartbeats[1].status, 0, "second heartbeat should be DOWN");
    });

    test("an invalid/inactive token is rejected; no monitor or heartbeat is created", async () => {
        const monitorsBefore = await R.count("monitor");
        const heartbeatsBefore = await R.count("heartbeat");

        const { status, body } = await postJson(
            port,
            "/api/federation/heartbeat",
            {
                agentMonitorId: "monitor-should-not-exist",
                name: "Should Not Be Created",
                type: "http",
                status: "up",
                msg: "OK",
                ping: 1,
            },
            { Authorization: "Bearer ri999999_totally-bogus-secret" }
        );

        assert.strictEqual(status, 401);
        assert.strictEqual(body.ok, false);

        const monitorsAfter = await R.count("monitor");
        const heartbeatsAfter = await R.count("heartbeat");
        assert.strictEqual(monitorsAfter, monitorsBefore, "no monitor should be created for an invalid token");
        assert.strictEqual(heartbeatsAfter, heartbeatsBefore, "no heartbeat should be created for an invalid token");

        // Also cover an inactive (deactivated) but otherwise valid remote_instance
        const { token, remoteInstanceID } = await registerRemoteInstance(userID, "instance-inactive", "Agent Inactive");
        await R.exec("UPDATE remote_instance SET active = 0 WHERE id = ? ", [remoteInstanceID]);

        const inactiveResult = await postJson(
            port,
            "/api/federation/heartbeat",
            {
                agentMonitorId: "monitor-inactive",
                name: "Inactive Agent Monitor",
                type: "http",
                status: "up",
                msg: "OK",
                ping: 1,
            },
            { Authorization: `Bearer ${token}` }
        );

        assert.strictEqual(inactiveResult.status, 401);
        assert.strictEqual(inactiveResult.body.ok, false);
    });

    test("remote_instance.last_seen is updated after a successful heartbeat", async () => {
        const { token, remoteInstanceID } = await registerRemoteInstance(userID, "instance-lastseen", "Agent LastSeen");

        const before = await R.findOne("remote_instance", " id = ? ", [remoteInstanceID]);
        assert.strictEqual(before.last_seen, null, "last_seen should start out NULL");

        const { status } = await postJson(
            port,
            "/api/federation/heartbeat",
            {
                agentMonitorId: "monitor-lastseen",
                name: "LastSeen Service",
                type: "http",
                status: "up",
                msg: "OK",
                ping: 5,
            },
            { Authorization: `Bearer ${token}` }
        );

        assert.strictEqual(status, 200);

        const after = await R.findOne("remote_instance", " id = ? ", [remoteInstanceID]);
        assert.ok(after.last_seen, "last_seen should be set after a successful heartbeat");
    });

    test("a malformed body (missing agentMonitorId, wrong types) is cleanly rejected, not a crash", async () => {
        const { token } = await registerRemoteInstance(userID, "instance-malformed", "Agent Malformed");

        // Missing agentMonitorId entirely
        const missingField = await postJson(
            port,
            "/api/federation/heartbeat",
            {
                name: "No Agent Monitor Id",
                type: "http",
                status: "up",
                msg: "OK",
                ping: 1,
            },
            { Authorization: `Bearer ${token}` }
        );
        assert.strictEqual(missingField.status, 400);
        assert.strictEqual(missingField.body.ok, false);

        // Wrong type for status (must be "up"/"down" enum)
        const wrongStatus = await postJson(
            port,
            "/api/federation/heartbeat",
            {
                agentMonitorId: "monitor-malformed",
                name: "Bad Status",
                type: "http",
                status: "definitely-not-a-status",
                msg: "OK",
                ping: 1,
            },
            { Authorization: `Bearer ${token}` }
        );
        assert.strictEqual(wrongStatus.status, 400);
        assert.strictEqual(wrongStatus.body.ok, false);

        // Wrong type for ping (string instead of number/null)
        const wrongPing = await postJson(
            port,
            "/api/federation/heartbeat",
            {
                agentMonitorId: "monitor-malformed-2",
                name: "Bad Ping",
                type: "http",
                status: "up",
                msg: "OK",
                ping: "not-a-number",
            },
            { Authorization: `Bearer ${token}` }
        );
        assert.strictEqual(wrongPing.status, 400);
        assert.strictEqual(wrongPing.body.ok, false);

        // No monitors should have been created by any of the malformed requests
        const remoteInstance = await R.findOne("remote_instance", " instance_id = ? ", ["instance-malformed"]);
        const monitors = await R.find("monitor", " remote_instance_id = ? ", [remoteInstance.id]);
        assert.strictEqual(monitors.length, 0, "no monitor should be created from malformed payloads");
    });

    test("getRemoteInstanceList returns instances for the user without leaking token_hash", async () => {
        await registerRemoteInstance(userID, "instance-list", "Agent List");

        // In production socket.actor is never bare undefined -- afterLogin
        // always attaches at least a minimal actor (ADR-0010 P3 fix), even on
        // an actor-build error. A memberships-less actor still carries the
        // correct userId, which is all scopeFilter's OFF-path needs to match
        // the legacy "WHERE user_id = ?" behaviour.
        const { buildActor } = require("../../server/security/authz");
        const socket = createMockSocket(userID, buildActor({ userId: userID, isSuperadmin: false }, []));
        remoteInstanceSocketHandler(socket);

        const result = await socket.trigger("getRemoteInstanceList");
        assert.strictEqual(result.ok, true);
        assert.ok(Array.isArray(result.remoteInstanceList));
        const found = result.remoteInstanceList.find((entry) => entry.instanceId === "instance-list");
        assert.ok(found, "registered instance should be present in the list");
        assert.ok(!("token_hash" in found));
        assert.ok(!("tokenHash" in found));
    });

    test("deleteRemoteInstance removes the registration but mirrored monitors survive with NULL fields (ON DELETE SET NULL)", async () => {
        const { token, remoteInstanceID } = await registerRemoteInstance(userID, "instance-delete", "Agent Delete");

        const { status } = await postJson(
            port,
            "/api/federation/heartbeat",
            {
                agentMonitorId: "monitor-delete",
                name: "Delete Me Not",
                type: "http",
                status: "up",
                msg: "OK",
                ping: 1,
            },
            { Authorization: `Bearer ${token}` }
        );
        assert.strictEqual(status, 200);

        const monitorBefore = await R.findOne("monitor", " remote_instance_id = ? AND remote_monitor_id = ? ", [
            remoteInstanceID,
            "monitor-delete",
        ]);
        assert.ok(monitorBefore, "monitor should exist before deletion");
        const monitorId = monitorBefore.id;

        const socket = createMockSocket(userID);
        remoteInstanceSocketHandler(socket);
        const deleteResult = await socket.trigger("deleteRemoteInstance", remoteInstanceID);
        assert.strictEqual(deleteResult.ok, true);

        const remoteInstanceAfter = await R.findOne("remote_instance", " id = ? ", [remoteInstanceID]);
        assert.strictEqual(remoteInstanceAfter, null, "remote_instance row should be gone");

        const monitorAfter = await R.findOne("monitor", " id = ? ", [monitorId]);
        assert.ok(monitorAfter, "mirrored monitor row should survive");
        assert.strictEqual(monitorAfter.remote_instance_id, null, "remote_instance_id should be reset to NULL");
    });

    // -------------------------------------------------------------------
    // ADR-0010 R7: a remote_instance (and every monitor it later mirrors)
    // must inherit the registering actor's team_id, not be born as a
    // cross-tenant-invisible orphan (team_id=NULL).
    // -------------------------------------------------------------------
    describe("R7: remote_instance and mirrored monitors inherit team_id", () => {
        let teamId;
        let teamActor;

        before(async () => {
            const { buildActor } = require("../../server/security/authz");

            const teamBean = R.dispense("team");
            teamBean.name = "Federation Team";
            teamBean.slug = "federation-r7-team";
            teamBean.is_system = false;
            teamBean.active = true;
            teamId = await R.store(teamBean);

            const ownerRole = await R.knex("role").whereNull("team_id").andWhere("slug", "owner").first();
            const membershipBean = R.dispense("team_user");
            membershipBean.team_id = teamId;
            membershipBean.user_id = userID;
            membershipBean.role_id = ownerRole.id;
            await R.store(membershipBean);

            teamActor = buildActor({ userId: userID, isSuperadmin: false }, [{ teamId, roleSlug: "owner" }], teamId);
        });

        test("addRemoteInstance sets team_id from the registering actor's activeTeamId", async () => {
            const { remoteInstanceID } = await registerRemoteInstance(
                userID,
                "instance-r7-team",
                "Agent R7",
                teamActor
            );

            const remoteInstance = await R.findOne("remote_instance", " id = ? ", [remoteInstanceID]);
            assert.strictEqual(remoteInstance.team_id, teamId);
        });

        test("addRemoteInstance leaves team_id null when no actor is attached (defensive, not a crash)", async () => {
            const { remoteInstanceID } = await registerRemoteInstance(
                userID,
                "instance-r7-no-actor",
                "Agent R7 No Actor"
            );

            const remoteInstance = await R.findOne("remote_instance", " id = ? ", [remoteInstanceID]);
            assert.strictEqual(remoteInstance.team_id, null);
        });

        test("a heartbeat's mirrored monitor inherits the remote_instance's team_id (not NULL)", async () => {
            const { token } = await registerRemoteInstance(userID, "instance-r7-heartbeat", "Agent R7 HB", teamActor);

            const { status, body } = await postJson(
                port,
                "/api/federation/heartbeat",
                {
                    agentMonitorId: "monitor-r7",
                    name: "R7 Service",
                    type: "http",
                    status: "up",
                    msg: "OK",
                    ping: 10,
                },
                { Authorization: `Bearer ${token}` }
            );
            assert.strictEqual(status, 200);
            assert.strictEqual(body.ok, true);

            const remoteInstance = await R.findOne("remote_instance", " instance_id = ? ", ["instance-r7-heartbeat"]);
            const monitor = await R.findOne("monitor", " remote_instance_id = ? AND remote_monitor_id = ? ", [
                remoteInstance.id,
                "monitor-r7",
            ]);

            assert.ok(monitor, "mirrored monitor should have been created");
            assert.strictEqual(monitor.team_id, teamId, "mirrored monitor must inherit the remote_instance's team_id");
            assert.notStrictEqual(monitor.team_id, null, "mirrored monitor must never be a team_id=NULL orphan");
        });

        test("getRemoteInstanceList (scopeFilter, enforcement OFF) still returns the legacy user_id-scoped list", async () => {
            const socket = createMockSocket(userID, teamActor);
            remoteInstanceSocketHandler(socket);

            const result = await socket.trigger("getRemoteInstanceList");
            assert.strictEqual(result.ok, true);
            const instanceIds = result.remoteInstanceList.map((r) => r.instanceId);
            assert.ok(
                instanceIds.includes("instance-r7-team"),
                "scopeFilter's OFF-path must match the legacy user_id filter"
            );
        });
    });
});
