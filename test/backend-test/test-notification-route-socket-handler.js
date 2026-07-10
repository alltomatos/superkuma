process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { buildActor } = require("../../server/security/authz");
const { notificationRouteSocketHandler } = require("../../server/socket-handlers/notification-route-socket-handler");

/**
 * Minimal mock Socket.io socket: captures `.on(event, handler)` registrations
 * so a test can `.trigger(event, ...args)` them directly, without a real
 * server/transport. checkLogin() only needs socket.userID truthy; the authz
 * layer only needs socket.actor.
 * @param {object} actor The RBAC actor for this fake connection (from buildActor()).
 * @param {number} userId The user id checkLogin() reads off the socket.
 * @returns {object} A fake socket with on()/trigger().
 */
function makeMockSocket(actor, userId) {
    const handlers = {};
    return {
        actor,
        userID: userId,
        on: (event, handler) => {
            handlers[event] = handler;
        },
        trigger: (event, ...args) =>
            new Promise((resolve) => {
                handlers[event](...args, resolve);
            }),
    };
}

let teamCounter = 0;

/**
 * Create a fresh, uniquely-slugged team.
 * @returns {Promise<number>} The new team's id
 */
async function createTeam() {
    teamCounter += 1;
    const slug = `route-handler-team-${teamCounter}`;
    await R.knex("team").insert({ name: slug, slug, is_system: false, active: true });
    return (await R.knex("team").where("slug", slug).first()).id;
}

let userCounter = 0;

/**
 * Create a fresh user row (not superadmin unless requested).
 * @param {object} fields Overrides, e.g. { isSuperadmin: true }
 * @returns {Promise<number>} The new user's id
 */
async function createUser(fields = {}) {
    userCounter += 1;
    const username = `route-handler-user-${userCounter}`;
    await R.knex("user").insert({ username, password: "x", is_superadmin: !!fields.isSuperadmin });
    return (await R.knex("user").where("username", username).first()).id;
}

/**
 * Build an actor for a user with a single team membership + role, mirroring
 * the fixture idiom in test-server-notification-authz.js.
 * @param {number} userId The user id
 * @param {number} teamId The team id
 * @param {string} roleSlug A built-in role slug ("owner"/"admin"/"editor"/"viewer")
 * @returns {object} An RBAC actor
 */
function actorFor(userId, teamId, roleSlug) {
    return buildActor({ userId, isSuperadmin: false }, [{ teamId, roleSlug }], teamId);
}

/**
 * Insert a notification row owned by a given user/team, molded on
 * test-monitor-send-notification.js's createNotification().
 * @param {number} userId The owning user id
 * @param {?number} teamId The owning team id (nullable)
 * @returns {Promise<number>} The notification's id
 */
async function createNotification(userId, teamId) {
    const bean = R.dispense("notification");
    bean.name = `route-handler-notif-${Date.now()}-${Math.random()}`;
    bean.config = JSON.stringify({ name: bean.name, type: "webhook" });
    bean.user_id = userId;
    bean.team_id = teamId;
    bean.active = true;
    bean.is_default = false;
    return await R.store(bean);
}

describe("notification-route-socket-handler.js (ADR-0014, TASK-A0-4)", () => {
    const testDb = new TestDB("./data/test-notification-route-socket-handler");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    describe("createNotificationRoute", () => {
        test("a team owner can create a team-scoped route", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const notifId = await createNotification(userId, teamId);
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            notificationRouteSocketHandler(socket);

            const res = await socket.trigger("createNotificationRoute", {
                teamId,
                minSeverity: "warning",
                monitorId: null,
                tagId: null,
                notificationId: notifId,
            });

            assert.strictEqual(res.ok, true, res.msg);
            const stored = await R.findOne("notification_route", "id = ?", [res.routeId]);
            assert.strictEqual(stored.team_id, teamId);
            assert.strictEqual(stored.min_severity, "warning");
        });

        test("a viewer (notification:read only, no notification:manage) is denied", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const notifId = await createNotification(userId, teamId);
            const socket = makeMockSocket(actorFor(userId, teamId, "viewer"), userId);
            notificationRouteSocketHandler(socket);

            const res = await socket.trigger("createNotificationRoute", {
                teamId,
                minSeverity: "critical",
                notificationId: notifId,
            });

            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /Permission denied/);
        });

        test("an actor with no membership in the target team is denied", async () => {
            const teamId = await createTeam();
            const outsiderTeamId = await createTeam();
            const userId = await createUser();
            const notifId = await createNotification(userId, teamId);
            const socket = makeMockSocket(actorFor(userId, outsiderTeamId, "owner"), userId);
            notificationRouteSocketHandler(socket);

            const res = await socket.trigger("createNotificationRoute", {
                teamId,
                minSeverity: "critical",
                notificationId: notifId,
            });

            assert.strictEqual(res.ok, false);
        });

        test("a non-superadmin is denied from creating a global (teamId=null) route", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const notifId = await createNotification(userId, teamId);
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            notificationRouteSocketHandler(socket);

            const res = await socket.trigger("createNotificationRoute", {
                teamId: null,
                minSeverity: "critical",
                notificationId: notifId,
            });

            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /superadmin/);
        });

        test("a superadmin CAN create a global (teamId=null) route", async () => {
            const teamId = await createTeam();
            const userId = await createUser({ isSuperadmin: true });
            const notifId = await createNotification(userId, teamId);
            const socket = makeMockSocket(buildActor({ userId, isSuperadmin: true }, []), userId);
            notificationRouteSocketHandler(socket);

            const res = await socket.trigger("createNotificationRoute", {
                teamId: null,
                minSeverity: "critical",
                notificationId: notifId,
            });

            assert.strictEqual(res.ok, true, res.msg);
            const stored = await R.findOne("notification_route", "id = ?", [res.routeId]);
            assert.strictEqual(stored.team_id, null);
        });

        test("linking a notification that belongs to a DIFFERENT team is denied", async () => {
            const teamId = await createTeam();
            const otherTeamId = await createTeam();
            const userId = await createUser();
            const otherUserId = await createUser();
            const notifInOtherTeam = await createNotification(otherUserId, otherTeamId);
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            notificationRouteSocketHandler(socket);

            const res = await socket.trigger("createNotificationRoute", {
                teamId,
                minSeverity: "critical",
                notificationId: notifInOtherTeam,
            });

            assert.strictEqual(res.ok, false);
        });

        test("an invalid min_severity value is rejected by validation before any DB write", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const notifId = await createNotification(userId, teamId);
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            notificationRouteSocketHandler(socket);

            const res = await socket.trigger("createNotificationRoute", {
                teamId,
                minSeverity: "catastrophic",
                notificationId: notifId,
            });

            assert.strictEqual(res.ok, false);
        });
    });

    describe("deleteNotificationRoute", () => {
        test("a team owner can delete their own team's route", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const notifId = await createNotification(userId, teamId);
            const routeBean = R.dispense("notification_route");
            routeBean.team_id = teamId;
            routeBean.min_severity = "critical";
            routeBean.notification_id = notifId;
            const routeId = await R.store(routeBean);

            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            notificationRouteSocketHandler(socket);

            const res = await socket.trigger("deleteNotificationRoute", { id: routeId });

            assert.strictEqual(res.ok, true, res.msg);
            assert.strictEqual(await R.findOne("notification_route", "id = ?", [routeId]), null);
        });

        test("an actor outside the route's team is denied", async () => {
            const teamId = await createTeam();
            const outsiderTeamId = await createTeam();
            const userId = await createUser();
            const notifId = await createNotification(userId, teamId);
            const routeBean = R.dispense("notification_route");
            routeBean.team_id = teamId;
            routeBean.min_severity = "critical";
            routeBean.notification_id = notifId;
            const routeId = await R.store(routeBean);

            const socket = makeMockSocket(actorFor(userId, outsiderTeamId, "owner"), userId);
            notificationRouteSocketHandler(socket);

            const res = await socket.trigger("deleteNotificationRoute", { id: routeId });

            assert.strictEqual(res.ok, false);
            assert.ok(await R.findOne("notification_route", "id = ?", [routeId]), "route must survive a denied delete");
        });

        test("a non-superadmin is denied from deleting a global route; a superadmin can", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const superId = await createUser({ isSuperadmin: true });
            const notifId = await createNotification(userId, teamId);
            const routeBean = R.dispense("notification_route");
            routeBean.team_id = null;
            routeBean.min_severity = "critical";
            routeBean.notification_id = notifId;
            const routeId = await R.store(routeBean);

            const memberSocket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            notificationRouteSocketHandler(memberSocket);
            const denied = await memberSocket.trigger("deleteNotificationRoute", { id: routeId });
            assert.strictEqual(denied.ok, false);
            assert.ok(await R.findOne("notification_route", "id = ?", [routeId]), "global route must survive a non-superadmin's attempt");

            const superSocket = makeMockSocket(buildActor({ userId: superId, isSuperadmin: true }, []), superId);
            notificationRouteSocketHandler(superSocket);
            const allowed = await superSocket.trigger("deleteNotificationRoute", { id: routeId });
            assert.strictEqual(allowed.ok, true, allowed.msg);
            assert.strictEqual(await R.findOne("notification_route", "id = ?", [routeId]), null);
        });

        test("deleting a nonexistent route id returns a clean error, not a crash", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            notificationRouteSocketHandler(socket);

            const res = await socket.trigger("deleteNotificationRoute", { id: 999999 });

            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /not found/);
        });
    });

    describe("getNotificationRouteList", () => {
        test("a team member sees their own team's routes plus global routes, not other teams'", async () => {
            const myTeamId = await createTeam();
            const otherTeamId = await createTeam();
            const userId = await createUser();
            const otherUserId = await createUser();
            const notifMine = await createNotification(userId, myTeamId);
            const notifOther = await createNotification(otherUserId, otherTeamId);

            const mine = R.dispense("notification_route");
            mine.team_id = myTeamId;
            mine.min_severity = "critical";
            mine.notification_id = notifMine;
            await R.store(mine);

            const other = R.dispense("notification_route");
            other.team_id = otherTeamId;
            other.min_severity = "critical";
            other.notification_id = notifOther;
            await R.store(other);

            const global = R.dispense("notification_route");
            global.team_id = null;
            global.min_severity = "info";
            global.notification_id = notifMine;
            await R.store(global);

            const socket = makeMockSocket(actorFor(userId, myTeamId, "viewer"), userId);
            notificationRouteSocketHandler(socket);

            const res = await socket.trigger("getNotificationRouteList");

            assert.strictEqual(res.ok, true, res.msg);
            const teamIds = res.routeList.map((r) => r.team_id);
            // Global (team_id=null) routes accumulate across this file's shared DB
            // (other tests create their own, by design never cleaned up), so assert
            // presence/absence rather than an exact full-list match.
            assert.ok(teamIds.includes(myTeamId), "own team's route must be visible");
            assert.ok(teamIds.includes(null), "at least one global route must be visible");
            assert.ok(!teamIds.includes(otherTeamId), "a different team's route must NOT be visible");
        });

        test("a superadmin sees every route, including other teams'", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const superId = await createUser({ isSuperadmin: true });
            const notifId = await createNotification(userId, teamId);

            const route = R.dispense("notification_route");
            route.team_id = teamId;
            route.min_severity = "critical";
            route.notification_id = notifId;
            await R.store(route);

            const socket = makeMockSocket(buildActor({ userId: superId, isSuperadmin: true }, []), superId);
            notificationRouteSocketHandler(socket);

            const res = await socket.trigger("getNotificationRouteList");

            assert.strictEqual(res.ok, true, res.msg);
            assert.ok(res.routeList.some((r) => r.team_id === teamId));
        });
    });
});
