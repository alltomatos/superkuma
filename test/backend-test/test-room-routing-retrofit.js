process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after, afterEach } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");

// server.js normally registers these dayjs plugins once at boot. This test
// requires modules directly (bypassing server.js), but Monitor's preload
// pipeline depends on them, exactly like other standalone socket-handler tests.
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { setEnforcementEnabled, buildActor } = require("../../server/security/authz");
const { roomFor } = require("../../server/security/rooms");
const { UptimeKumaServer } = require("../../server/uptime-kuma-server");
const {
    sendNotificationList,
    sendProxyList,
    sendAPIKeyList,
    sendDockerHostList,
    sendRemoteBrowserList,
    sendMonitorTypeList,
    sendHeartbeatList,
    sendImportantHeartbeatList,
} = require("../../server/client");
const StatusPage = require("../../server/model/status_page");
const { cloudflaredSocketHandler } = require("../../server/socket-handlers/cloudflared-socket-handler");
const ioClient = require("socket.io-client");

/**
 * Build a minimal fake Socket.io socket carrying only the fields the
 * retrofitted send<X>List functions read: `userID`/`actor` for room
 * selection, plus no-op `emit`/`join`/`on` so handlers that touch them don't
 * throw.
 * @param {number} userID The legacy user id (used for the OFF-path room).
 * @param {object|null} actor The RBAC actor to attach (or null).
 * @returns {object} A stub socket.
 */
function makeSocket(userID, actor) {
    return {
        userID,
        actor,
        emit() {},
        join() {},
        on() {},
    };
}

/**
 * Monkeypatch the shared Socket.io server's `to()` method for the duration of
 * `work()`, capturing every room name it was called with, then restore the
 * original implementation. Since every retrofitted call site ultimately reads
 * `UptimeKumaServer.getInstance().io` (directly or via a captured module-level
 * reference to the same object), patching the shared instance's method is
 * visible to all of them.
 * @param {Function} work Async function to run while the spy is installed
 * @returns {Promise<string[]>} The room names `to()` was called with, in order
 */
async function withRoomSpy(work) {
    const server = UptimeKumaServer.getInstance();
    const realTo = server.io.to.bind(server.io);
    const calls = [];
    server.io.to = (room) => {
        calls.push(room);
        return realTo(room);
    };
    try {
        await work();
    } finally {
        server.io.to = realTo;
    }
    return calls;
}

describe("Socket.io room-routing retrofit (ADR-0010 P4)", () => {
    const testDb = new TestDB("./data/test-room-routing-retrofit");
    let userId;
    let teamId;

    /**
     * Build a real RBAC actor for the shared test user/team, active in that team.
     * @returns {object} An actor built via buildActor
     */
    function actor() {
        return buildActor({ userId, isSuperadmin: false }, [{ teamId, roleSlug: "viewer" }], teamId);
    }

    before(async () => {
        await testDb.create();

        const bUser = R.dispense("user");
        bUser.username = "room-routing-user";
        bUser.password = "x";
        userId = await R.store(bUser);

        const bTeam = R.dispense("team");
        bTeam.name = "Room Routing Team";
        bTeam.slug = "room-routing-team";
        bTeam.is_system = false;
        bTeam.active = true;
        teamId = await R.store(bTeam);
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    afterEach(() => setEnforcementEnabled(false));

    // -----------------------------------------------------------------
    // client.js: every per-user emit site must route through roomFor.
    // -----------------------------------------------------------------
    describe("client.js: per-user emit sites route through roomFor", () => {
        const sites = [
            { name: "sendNotificationList", call: (socket) => sendNotificationList(socket) },
            { name: "sendProxyList", call: (socket) => sendProxyList(socket) },
            { name: "sendAPIKeyList", call: (socket) => sendAPIKeyList(socket) },
            { name: "sendDockerHostList", call: (socket) => sendDockerHostList(socket) },
            { name: "sendRemoteBrowserList", call: (socket) => sendRemoteBrowserList(socket) },
            { name: "sendMonitorTypeList", call: (socket) => sendMonitorTypeList(socket) },
            {
                name: "sendHeartbeatList(toUser=true)",
                call: (socket) => sendHeartbeatList(socket, 999999999, true, false),
            },
            {
                name: "sendImportantHeartbeatList(toUser=true)",
                call: (socket) => sendImportantHeartbeatList(socket, 999999999, true, false),
            },
        ];

        for (const site of sites) {
            test(`${site.name}: enforcement OFF uses the legacy per-user room`, async () => {
                const socket = makeSocket(userId, actor());
                const calls = await withRoomSpy(() => site.call(socket));
                assert.deepStrictEqual(calls, [String(userId)]);
            });

            test(`${site.name}: enforcement ON uses the team room`, async () => {
                setEnforcementEnabled(true);
                const socket = makeSocket(userId, actor());
                const calls = await withRoomSpy(() => site.call(socket));
                assert.deepStrictEqual(calls, ["team:" + teamId]);
            });
        }
    });

    // -----------------------------------------------------------------
    // uptime-kuma-server.js: monitor + maintenance list emit sites.
    // -----------------------------------------------------------------
    describe("uptime-kuma-server.js: monitor/maintenance emit sites route through roomFor", () => {
        let monitorId;

        before(async () => {
            const bMonitor = R.dispense("monitor");
            bMonitor.name = "room-routing-monitor";
            bMonitor.type = "push";
            bMonitor.user_id = userId;
            bMonitor.team_id = teamId;
            bMonitor.interval = 60;
            bMonitor.retryInterval = 60;
            bMonitor.active = true;
            monitorId = await R.store(bMonitor);
        });

        test("sendMonitorList: enforcement OFF uses the legacy per-user room", async () => {
            const server = UptimeKumaServer.getInstance();
            const socket = makeSocket(userId, actor());
            const calls = await withRoomSpy(() => server.sendMonitorList(socket));
            assert.deepStrictEqual(calls, [String(userId)]);
        });

        test("sendMonitorList: enforcement ON uses the team room", async () => {
            setEnforcementEnabled(true);
            const server = UptimeKumaServer.getInstance();
            const socket = makeSocket(userId, actor());
            const calls = await withRoomSpy(() => server.sendMonitorList(socket));
            assert.deepStrictEqual(calls, ["team:" + teamId]);
        });

        test("sendUpdateMonitorIntoList: enforcement OFF uses the legacy per-user room", async () => {
            const server = UptimeKumaServer.getInstance();
            const socket = makeSocket(userId, actor());
            const calls = await withRoomSpy(() => server.sendUpdateMonitorIntoList(socket, monitorId));
            assert.deepStrictEqual(calls, [String(userId)]);
        });

        test("sendUpdateMonitorIntoList: enforcement ON uses the team room", async () => {
            setEnforcementEnabled(true);
            const server = UptimeKumaServer.getInstance();
            const socket = makeSocket(userId, actor());
            const calls = await withRoomSpy(() => server.sendUpdateMonitorIntoList(socket, monitorId));
            assert.deepStrictEqual(calls, ["team:" + teamId]);
        });

        test("sendDeleteMonitorFromList: enforcement OFF uses the legacy per-user room", async () => {
            const server = UptimeKumaServer.getInstance();
            const socket = makeSocket(userId, actor());
            const calls = await withRoomSpy(() => server.sendDeleteMonitorFromList(socket, monitorId));
            assert.deepStrictEqual(calls, [String(userId)]);
        });

        test("sendDeleteMonitorFromList: enforcement ON uses the team room", async () => {
            setEnforcementEnabled(true);
            const server = UptimeKumaServer.getInstance();
            const socket = makeSocket(userId, actor());
            const calls = await withRoomSpy(() => server.sendDeleteMonitorFromList(socket, monitorId));
            assert.deepStrictEqual(calls, ["team:" + teamId]);
        });

        test("sendMaintenanceList: enforcement OFF uses the legacy per-user room", async () => {
            const server = UptimeKumaServer.getInstance();
            const socket = makeSocket(userId, actor());
            const calls = await withRoomSpy(() => server.sendMaintenanceList(socket));
            assert.deepStrictEqual(calls, [String(userId)]);
        });

        test("sendMaintenanceList: enforcement ON uses the team room", async () => {
            setEnforcementEnabled(true);
            const server = UptimeKumaServer.getInstance();
            const socket = makeSocket(userId, actor());
            const calls = await withRoomSpy(() => server.sendMaintenanceList(socket));
            assert.deepStrictEqual(calls, ["team:" + teamId]);
        });
    });

    // -----------------------------------------------------------------
    // model/status_page.js: sendStatusPageList takes `io` as an explicit
    // parameter, so it gets its own lightweight fake instead of the shared spy.
    // -----------------------------------------------------------------
    describe("model/status_page.js: sendStatusPageList routes through roomFor", () => {
        /**
         * Build a minimal fake Socket.io server exposing only `to()`.
         * @returns {{calls: string[], to: Function}} Fake io + captured room names
         */
        function makeIoSpy() {
            const calls = [];
            return {
                calls,
                to(room) {
                    calls.push(room);
                    return { emit() {} };
                },
            };
        }

        test("enforcement OFF uses the legacy per-user room", async () => {
            const io = makeIoSpy();
            const socket = makeSocket(userId, actor());
            await StatusPage.sendStatusPageList(io, socket);
            assert.deepStrictEqual(io.calls, [String(userId)]);
        });

        test("enforcement ON uses the team room", async () => {
            setEnforcementEnabled(true);
            const io = makeIoSpy();
            const socket = makeSocket(userId, actor());
            await StatusPage.sendStatusPageList(io, socket);
            assert.deepStrictEqual(io.calls, ["team:" + teamId]);
        });
    });

    // -----------------------------------------------------------------
    // cloudflared-socket-handler.js: the 3 per-user emits in the "join"
    // handler. The global "cloudflared" room used by cloudflared.change/error
    // is untouched by this retrofit and is not exercised here.
    // -----------------------------------------------------------------
    describe("cloudflared-socket-handler.js: join handler routes through roomFor", () => {
        /**
         * Register the cloudflared handler on a stub socket and return its
         * captured "cloudflared_join" listener.
         * @param {object} socket Stub socket to register handlers on
         * @returns {Function} The registered join handler
         */
        function registerJoinHandler(socket) {
            const handlers = {};
            socket.on = (event, handler) => {
                handlers[event] = handler;
            };
            cloudflaredSocketHandler(socket);
            return handlers["cloudflared_join"];
        }

        test("enforcement OFF: all 3 emits use the legacy per-user room", async () => {
            const socket = makeSocket(userId, actor());
            const join = registerJoinHandler(socket);
            const calls = await withRoomSpy(() => join());
            assert.deepStrictEqual(calls, [String(userId), String(userId), String(userId)]);
        });

        test("enforcement ON: all 3 emits use the team room", async () => {
            setEnforcementEnabled(true);
            const socket = makeSocket(userId, actor());
            const join = registerJoinHandler(socket);
            const calls = await withRoomSpy(() => join());
            assert.deepStrictEqual(calls, ["team:" + teamId, "team:" + teamId, "team:" + teamId]);
        });
    });

    // -----------------------------------------------------------------
    // Real Socket.io delivery: proves the underlying capability, not just
    // which string gets passed to roomFor(). Two real connected clients;
    // OFF must keep them isolated even in the same team (byte-identical to
    // legacy per-user rooms), ON must deliver to both as genuinely new
    // team-wide broadcast behaviour.
    // -----------------------------------------------------------------
    describe("real Socket.io delivery: team broadcast vs legacy per-user isolation", () => {
        let server;
        let port;
        let otherUserId;

        before(async () => {
            const bOtherUser = R.dispense("user");
            bOtherUser.username = "room-routing-user-b";
            bOtherUser.password = "x";
            otherUserId = await R.store(bOtherUser);

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
            await new Promise((resolve) => server.httpServer.close(resolve));
        });

        /**
         * Connect a real socket.io-client socket, joining a room server-side
         * based on the query params (mirrors afterLogin's roomFor(...) join,
         * without needing full login/auth machinery).
         * @param {number} qUserId Legacy user id to join with
         * @param {number} qTeamId Team id to join with
         * @returns {Promise<object>} The connected client socket
         */
        function connectClient(qUserId, qTeamId) {
            return new Promise((resolve, reject) => {
                const client = ioClient(`http://127.0.0.1:${port}`, {
                    query: { userId: String(qUserId), teamId: String(qTeamId) },
                    transports: ["websocket"],
                    reconnection: false,
                });
                client.once("connect", () => resolve(client));
                client.once("connect_error", reject);
            });
        }

        test("enforcement OFF: a broadcast to userA's legacy room does not reach userB's socket, even in the same team", async () => {
            const clientA = await connectClient(userId, teamId);
            const clientB = await connectClient(otherUserId, teamId);
            try {
                const receivedA = new Promise((resolve) => clientA.once("probe", resolve));
                let receivedB = false;
                clientB.once("probe", () => {
                    receivedB = true;
                });

                server.io.to(roomFor(userId, teamId)).emit("probe", "hello-a");

                assert.strictEqual(await receivedA, "hello-a");
                // Grace period: prove B genuinely never receives it, not just "hasn't yet".
                await new Promise((resolve) => setTimeout(resolve, 200));
                assert.strictEqual(receivedB, false, "a different user must not receive another user's room broadcast");
            } finally {
                clientA.close();
                clientB.close();
            }
        });

        test("enforcement ON: a broadcast to the shared team room reaches every team member's socket", async () => {
            setEnforcementEnabled(true);
            const clientA = await connectClient(userId, teamId);
            const clientB = await connectClient(otherUserId, teamId);
            try {
                const receivedA = new Promise((resolve) => clientA.once("probe", resolve));
                const receivedB = new Promise((resolve) => clientB.once("probe", resolve));

                server.io.to(roomFor(userId, teamId)).emit("probe", "hello-team");

                const [a, b] = await Promise.all([receivedA, receivedB]);
                assert.strictEqual(a, "hello-team");
                assert.strictEqual(b, "hello-team", "both team members must receive the same team-room broadcast");
            } finally {
                clientA.close();
                clientB.close();
            }
        });
    });
});
