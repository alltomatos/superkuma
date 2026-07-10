process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { buildActor } = require("../../server/security/authz");
const { dashboardSocketHandler } = require("../../server/socket-handlers/dashboard-socket-handler");

/**
 * Minimal mock Socket.io socket: captures `.on(event, handler)` registrations
 * so a test can `.trigger(event, ...args)` them directly, without a real
 * server/transport. Mirrors test-notification-route-socket-handler.js.
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
    const slug = `dashboard-handler-team-${teamCounter}`;
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
    const username = `dashboard-handler-user-${userCounter}`;
    await R.knex("user").insert({ username, password: "x", is_superadmin: !!fields.isSuperadmin });
    return (await R.knex("user").where("username", username).first()).id;
}

/**
 * Build an actor for a user with a single team membership + role.
 * @param {number} userId The user id
 * @param {number} teamId The team id
 * @param {string} roleSlug A built-in role slug ("owner"/"admin"/"editor"/"viewer")
 * @returns {object} An RBAC actor
 */
function actorFor(userId, teamId, roleSlug) {
    return buildActor({ userId, isSuperadmin: false }, [{ teamId, roleSlug }], teamId);
}

/**
 * Insert a minimal valid monitor row owned by a given team.
 * @param {number} teamId The owning team id
 * @returns {Promise<number>} The monitor's id
 */
async function createMonitor(teamId) {
    const bean = R.dispense("monitor");
    bean.name = `dashboard-handler-monitor-${Date.now()}-${Math.random()}`;
    bean.type = "http";
    bean.url = "https://example.com";
    bean.interval = 60;
    bean.team_id = teamId;
    return await R.store(bean);
}

describe("dashboard-socket-handler.js (ADR-0016)", () => {
    const testDb = new TestDB("./data/test-dashboard-socket-handler");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    describe("createDashboard", () => {
        test("an editor can create a dashboard, stored in their own active team", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const socket = makeMockSocket(actorFor(userId, teamId, "editor"), userId);
            dashboardSocketHandler(socket);

            const res = await socket.trigger("createDashboard", { title: "Network" });

            assert.strictEqual(res.ok, true, res.msg);
            const stored = await R.findOne("dashboard", "id = ?", [res.dashboardId]);
            assert.strictEqual(stored.team_id, teamId);
            assert.strictEqual(stored.title, "Network");
        });

        test("a viewer (dashboard:read only, no dashboard:manage) is denied", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const socket = makeMockSocket(actorFor(userId, teamId, "viewer"), userId);
            dashboardSocketHandler(socket);

            const res = await socket.trigger("createDashboard", { title: "Network" });

            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /Permission denied/);
        });

        test("team_id is never taken from client input -- the payload has no such field to give", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(socket);

            // Extra/unexpected fields are simply not in the schema -- zod strips
            // them silently (no .strict()), so even attempting a teamId in the
            // payload cannot influence the stored value.
            const res = await socket.trigger("createDashboard", { title: "Servers", teamId: 999999 });

            assert.strictEqual(res.ok, true, res.msg);
            const stored = await R.findOne("dashboard", "id = ?", [res.dashboardId]);
            assert.strictEqual(stored.team_id, teamId, "must use the actor's real team, not the payload's teamId");
        });

        test("an empty title is rejected by validation", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(socket);

            const res = await socket.trigger("createDashboard", { title: "" });

            assert.strictEqual(res.ok, false);
        });
    });

    describe("saveDashboard", () => {
        test("an owner can save an ordered widget list onto their own dashboard", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const m1 = await createMonitor(teamId);
            const m2 = await createMonitor(teamId);
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(socket);

            const created = await socket.trigger("createDashboard", { title: "Fleet" });
            const dashboardId = created.dashboardId;

            const res = await socket.trigger("saveDashboard", {
                id: dashboardId,
                widgets: [
                    { monitorId: m1, kind: "metric_gauge", sectionName: "Firewalls" },
                    { monitorId: m2, kind: "status_tile" },
                ],
            });

            assert.strictEqual(res.ok, true, res.msg);
            assert.strictEqual(res.widgetCount, 2);

            const widgets = await R.getAll(
                "SELECT * FROM dashboard_widget WHERE dashboard_id = ? ORDER BY sort_order",
                [dashboardId]
            );
            assert.strictEqual(widgets.length, 2);
            assert.strictEqual(widgets[0].monitor_id, m1);
            assert.strictEqual(widgets[0].kind, "metric_gauge");
            assert.strictEqual(widgets[0].section_name, "Firewalls");
            assert.strictEqual(widgets[1].monitor_id, m2);
            assert.strictEqual(widgets[1].sort_order, 1);
        });

        test("saving again fully replaces the previous widget list", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const m1 = await createMonitor(teamId);
            const m2 = await createMonitor(teamId);
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(socket);

            const created = await socket.trigger("createDashboard", { title: "Replaceable" });
            const dashboardId = created.dashboardId;
            await socket.trigger("saveDashboard", { id: dashboardId, widgets: [{ monitorId: m1 }] });

            const res = await socket.trigger("saveDashboard", { id: dashboardId, widgets: [{ monitorId: m2 }] });

            assert.strictEqual(res.ok, true, res.msg);
            const widgets = await R.getAll("SELECT * FROM dashboard_widget WHERE dashboard_id = ?", [dashboardId]);
            assert.strictEqual(widgets.length, 1);
            assert.strictEqual(widgets[0].monitor_id, m2);
        });

        test("linking a monitor from a DIFFERENT team is denied, and existing widgets survive untouched", async () => {
            const teamId = await createTeam();
            const otherTeamId = await createTeam();
            const userId = await createUser();
            const mine = await createMonitor(teamId);
            const otherTeamsMonitor = await createMonitor(otherTeamId);
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(socket);

            const created = await socket.trigger("createDashboard", { title: "Guarded" });
            const dashboardId = created.dashboardId;
            await socket.trigger("saveDashboard", { id: dashboardId, widgets: [{ monitorId: mine }] });

            const res = await socket.trigger("saveDashboard", {
                id: dashboardId,
                widgets: [{ monitorId: otherTeamsMonitor }],
            });

            assert.strictEqual(res.ok, false);
            const widgets = await R.getAll("SELECT * FROM dashboard_widget WHERE dashboard_id = ?", [dashboardId]);
            assert.strictEqual(widgets.length, 1, "the rejected save must not have wiped the existing widget");
            assert.strictEqual(widgets[0].monitor_id, mine);
        });

        test("an actor outside the dashboard's team is denied", async () => {
            const teamId = await createTeam();
            const outsiderTeamId = await createTeam();
            const userId = await createUser();
            const monitorId = await createMonitor(teamId);
            const ownerSocket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(ownerSocket);
            const created = await ownerSocket.trigger("createDashboard", { title: "Private" });

            const outsiderSocket = makeMockSocket(actorFor(userId, outsiderTeamId, "owner"), userId);
            dashboardSocketHandler(outsiderSocket);
            const res = await outsiderSocket.trigger("saveDashboard", {
                id: created.dashboardId,
                widgets: [{ monitorId }],
            });

            assert.strictEqual(res.ok, false);
        });

        test("an invalid widget kind is rejected by validation before any DB write", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const monitorId = await createMonitor(teamId);
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(socket);
            const created = await socket.trigger("createDashboard", { title: "Strict" });

            const res = await socket.trigger("saveDashboard", {
                id: created.dashboardId,
                widgets: [{ monitorId, kind: "pie_chart_3000" }],
            });

            assert.strictEqual(res.ok, false);
            const widgets = await R.getAll("SELECT * FROM dashboard_widget WHERE dashboard_id = ?", [
                created.dashboardId,
            ]);
            assert.strictEqual(widgets.length, 0);
        });

        test("an optional title update is applied alongside the widget replace", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(socket);
            const created = await socket.trigger("createDashboard", { title: "Old Name" });

            const res = await socket.trigger("saveDashboard", {
                id: created.dashboardId,
                title: "New Name",
                widgets: [],
            });

            assert.strictEqual(res.ok, true, res.msg);
            const stored = await R.findOne("dashboard", "id = ?", [created.dashboardId]);
            assert.strictEqual(stored.title, "New Name");
        });
    });

    describe("deleteDashboard", () => {
        test("an owner can delete their own team's dashboard, and its widgets cascade away", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const monitorId = await createMonitor(teamId);
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(socket);
            const created = await socket.trigger("createDashboard", { title: "Gone Soon" });
            await socket.trigger("saveDashboard", { id: created.dashboardId, widgets: [{ monitorId }] });

            const res = await socket.trigger("deleteDashboard", { id: created.dashboardId });

            assert.strictEqual(res.ok, true, res.msg);
            assert.strictEqual(await R.findOne("dashboard", "id = ?", [created.dashboardId]), null);
            const widgets = await R.getAll("SELECT * FROM dashboard_widget WHERE dashboard_id = ?", [
                created.dashboardId,
            ]);
            assert.strictEqual(widgets.length, 0, "widgets must cascade-delete with their dashboard");
        });

        test("an actor outside the dashboard's team is denied, and the dashboard survives", async () => {
            const teamId = await createTeam();
            const outsiderTeamId = await createTeam();
            const userId = await createUser();
            const ownerSocket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(ownerSocket);
            const created = await ownerSocket.trigger("createDashboard", { title: "Protected" });

            const outsiderSocket = makeMockSocket(actorFor(userId, outsiderTeamId, "owner"), userId);
            dashboardSocketHandler(outsiderSocket);
            const res = await outsiderSocket.trigger("deleteDashboard", { id: created.dashboardId });

            assert.strictEqual(res.ok, false);
            assert.ok(await R.findOne("dashboard", "id = ?", [created.dashboardId]), "must survive a denied delete");
        });

        test("deleting a nonexistent dashboard id returns a clean error, not a crash", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(socket);

            const res = await socket.trigger("deleteDashboard", { id: 999999 });

            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /not found/);
        });
    });

    describe("getDashboardList", () => {
        test("a team member sees only their own team's dashboards, not other teams'", async () => {
            const myTeamId = await createTeam();
            const otherTeamId = await createTeam();
            const userId = await createUser();
            const mySocket = makeMockSocket(actorFor(userId, myTeamId, "viewer"), userId);
            dashboardSocketHandler(mySocket);

            const ownerSocket = makeMockSocket(actorFor(userId, myTeamId, "owner"), userId);
            dashboardSocketHandler(ownerSocket);
            await ownerSocket.trigger("createDashboard", { title: "Mine" });

            const otherOwnerSocket = makeMockSocket(actorFor(userId, otherTeamId, "owner"), userId);
            dashboardSocketHandler(otherOwnerSocket);
            await otherOwnerSocket.trigger("createDashboard", { title: "Not Mine" });

            const res = await mySocket.trigger("getDashboardList");

            assert.strictEqual(res.ok, true, res.msg);
            const teamIds = res.dashboardList.map((d) => d.teamId);
            assert.ok(teamIds.includes(myTeamId), "own team's dashboard must be visible");
            assert.ok(!teamIds.includes(otherTeamId), "a different team's dashboard must NOT be visible");
        });

        test("a superadmin sees every team's dashboards", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const superId = await createUser({ isSuperadmin: true });
            const ownerSocket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(ownerSocket);
            await ownerSocket.trigger("createDashboard", { title: "Visible To Super" });

            const superSocket = makeMockSocket(buildActor({ userId: superId, isSuperadmin: true }, []), superId);
            dashboardSocketHandler(superSocket);

            const res = await superSocket.trigger("getDashboardList");

            assert.strictEqual(res.ok, true, res.msg);
            assert.ok(res.dashboardList.some((d) => d.teamId === teamId));
        });
    });

    describe("getDashboard", () => {
        test("returns the dashboard and its widgets with monitor name/type joined in", async () => {
            const teamId = await createTeam();
            const userId = await createUser();
            const monitorId = await createMonitor(teamId);
            const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(socket);
            const created = await socket.trigger("createDashboard", { title: "Detailed" });
            await socket.trigger("saveDashboard", {
                id: created.dashboardId,
                widgets: [{ monitorId, kind: "metric_gauge", sectionName: "Core" }],
            });

            const res = await socket.trigger("getDashboard", { id: created.dashboardId });

            assert.strictEqual(res.ok, true, res.msg);
            assert.strictEqual(res.dashboard.title, "Detailed");
            assert.strictEqual(res.widgets.length, 1);
            assert.strictEqual(res.widgets[0].monitorId, monitorId);
            assert.strictEqual(res.widgets[0].kind, "metric_gauge");
            assert.strictEqual(res.widgets[0].sectionName, "Core");
            assert.ok(res.widgets[0].monitorName, "monitor name should be joined in for display");
        });

        test("an actor outside the dashboard's team is denied", async () => {
            const teamId = await createTeam();
            const outsiderTeamId = await createTeam();
            const userId = await createUser();
            const ownerSocket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
            dashboardSocketHandler(ownerSocket);
            const created = await ownerSocket.trigger("createDashboard", { title: "Hidden" });

            const outsiderSocket = makeMockSocket(actorFor(userId, outsiderTeamId, "viewer"), userId);
            dashboardSocketHandler(outsiderSocket);
            const res = await outsiderSocket.trigger("getDashboard", { id: created.dashboardId });

            assert.strictEqual(res.ok, false);
        });
    });
});
