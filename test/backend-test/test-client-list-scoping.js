process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { setEnforcementEnabled, buildActor } = require("../../server/security/authz");
const {
    sendNotificationList,
    sendProxyList,
    sendAPIKeyList,
    sendDockerHostList,
    sendRemoteBrowserList,
} = require("../../server/client");

/**
 * Build a minimal fake Socket.io socket sufficient for the send<X>List
 * functions under test: they only read `socket.userID`/`socket.actor` and
 * call `io.to(...).emit(...)` (real `io`, real room, no listener needed) plus
 * `socket.emit` for a couple of unrelated paths we don't exercise here.
 * @param {number} userID The legacy user id (used for the OFF-path filter and rooms).
 * @param {object|null} actor The RBAC actor to attach (or null).
 * @returns {object} A stub socket.
 */
function makeSocket(userID, actor) {
    return {
        userID,
        actor,
        emit() {},
    };
}

describe("client.js send<X>List team-scoping (ADR-0010 P3 retrofit)", () => {
    const testDb = new TestDB("./data/test-client-list-scoping");

    let teamA;
    let teamB;
    let userA; // member of team A only
    let userB; // member of team B only

    before(async () => {
        await testDb.create();

        // Two real users, two real teams (beyond the migration's Default Team),
        // each user a member of exactly one team.
        const bUser1 = R.dispense("user");
        bUser1.username = "list-scope-user-a";
        bUser1.password = "x";
        userA = await R.store(bUser1);

        const bUser2 = R.dispense("user");
        bUser2.username = "list-scope-user-b";
        bUser2.password = "x";
        userB = await R.store(bUser2);

        const bTeamA = R.dispense("team");
        bTeamA.name = "Team A";
        bTeamA.slug = "team-a-list-scope";
        bTeamA.is_system = false;
        bTeamA.active = true;
        teamA = await R.store(bTeamA);

        const bTeamB = R.dispense("team");
        bTeamB.name = "Team B";
        bTeamB.slug = "team-b-list-scope";
        bTeamB.is_system = false;
        bTeamB.active = true;
        teamB = await R.store(bTeamB);

        // One row per resource type in EACH team, all "legacy"-owned by userA
        // via user_id (mirrors a pre-RBAC single-user install: user_id says
        // userA owns everything, but team_id says otherwise for the "B" rows).
        // This is what lets us tell the OFF-path (user_id) apart from the
        // ON-path (team_id) filter.
        const seedRow = async (table, extra, teamId) => {
            const bean = R.dispense(table);
            Object.assign(bean, extra, { user_id: userA, team_id: teamId });
            return R.store(bean);
        };

        await seedRow("notification", { name: "notif-A", active: true, is_default: false, config: "{}" }, teamA);
        await seedRow("notification", { name: "notif-B", active: true, is_default: false, config: "{}" }, teamB);

        await seedRow(
            "proxy",
            { protocol: "http", host: "a.example.com", port: 8080, auth: false, active: true, default: false },
            teamA
        );
        await seedRow(
            "proxy",
            { protocol: "http", host: "b.example.com", port: 8080, auth: false, active: true, default: false },
            teamB
        );

        await seedRow(
            "docker_host",
            { docker_daemon: "unix:///var/run/docker-a.sock", docker_type: "socket", name: "docker-A" },
            teamA
        );
        await seedRow(
            "docker_host",
            { docker_daemon: "unix:///var/run/docker-b.sock", docker_type: "socket", name: "docker-B" },
            teamB
        );

        await seedRow("remote_browser", { name: "browser-A", url: "ws://a.example.com" }, teamA);
        await seedRow("remote_browser", { name: "browser-B", url: "ws://b.example.com" }, teamB);

        await seedRow("api_key", { key: "key-hash-a", name: "key-A", active: true }, teamA);
        await seedRow("api_key", { key: "key-hash-b", name: "key-B", active: true }, teamB);
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    // -----------------------------------------------------------------
    // Enforcement OFF (default / dark-launch): byte-identical to legacy.
    // -----------------------------------------------------------------
    describe("enforcement OFF (default): unchanged legacy user_id-scoped behaviour", () => {
        test("sendNotificationList returns exactly the rows owned by socket.userID, regardless of team", async () => {
            const socket = makeSocket(
                userA,
                buildActor({ userId: userA, isSuperadmin: false }, [{ teamId: teamA, roleSlug: "viewer" }], teamA)
            );
            const list = await sendNotificationList(socket);
            assert.strictEqual(list.length, 2, "both notif-A and notif-B are owned by userA via user_id");
            const names = list.map((b) => b.name).sort();
            assert.deepStrictEqual(names, ["notif-A", "notif-B"]);
        });

        // NOTE: socket.actor is populated by afterLogin() for every real login
        // (see server/server.js). We build a realistic non-null actor here to
        // match that normal path. A defensive try/catch in afterLogin can leave
        // socket.actor === null on an actor-build error; scopeFilter's OFF-path
        // does `actor.userId` unconditionally and throws TypeError on a null
        // actor (verified directly against server/security/authz.js -- this is
        // a pre-existing gap in scopeFilter itself, not introduced by this
        // retrofit, and out of scope for this file-only change; flagged in the
        // task report instead of silently patched here per the "no extra
        // null-guards" instruction).
        const actorForA = () =>
            buildActor({ userId: userA, isSuperadmin: false }, [{ teamId: teamA, roleSlug: "viewer" }], teamA);
        const actorForB = () =>
            buildActor({ userId: userB, isSuperadmin: false }, [{ teamId: teamB, roleSlug: "viewer" }], teamB);

        test("sendProxyList returns exactly the rows owned by socket.userID", async () => {
            const socket = makeSocket(userA, actorForA());
            const list = await sendProxyList(socket);
            assert.strictEqual(list.length, 2);
            const hosts = list.map((b) => b.host).sort();
            assert.deepStrictEqual(hosts, ["a.example.com", "b.example.com"]);
        });

        test("sendAPIKeyList returns exactly the rows owned by socket.userID", async () => {
            const socket = makeSocket(userA, actorForA());
            const list = await sendAPIKeyList(socket);
            assert.strictEqual(list.length, 2);
            const names = list.map((b) => b.name).sort();
            assert.deepStrictEqual(names, ["key-A", "key-B"]);
        });

        test("sendDockerHostList returns exactly the rows owned by socket.userID", async () => {
            const socket = makeSocket(userA, actorForA());
            const list = await sendDockerHostList(socket);
            assert.strictEqual(list.length, 2);
            const names = list.map((b) => b.name).sort();
            assert.deepStrictEqual(names, ["docker-A", "docker-B"]);
        });

        test("sendRemoteBrowserList returns exactly the rows owned by socket.userID", async () => {
            const socket = makeSocket(userA, actorForA());
            const list = await sendRemoteBrowserList(socket);
            assert.strictEqual(list.length, 2);
            const names = list.map((b) => b.name).sort();
            assert.deepStrictEqual(names, ["browser-A", "browser-B"]);
        });

        test("a user with no rows (userB has none via user_id) sees an empty list", async () => {
            const socket = makeSocket(userB, actorForB());
            const list = await sendProxyList(socket);
            assert.strictEqual(list.length, 0, "userB owns nothing via user_id, even though team B rows exist");
        });
    });

    // -----------------------------------------------------------------
    // Enforcement ON: real two-team scenario, scoped by team_id.
    // -----------------------------------------------------------------
    describe("enforcement ON: team-scoped visibility via scopeFilter", () => {
        before(() => setEnforcementEnabled(true));
        after(() => setEnforcementEnabled(false));

        test("an actor who is only a member of team B sees only team B's notifications, not userA's team A rows", async () => {
            // userB is not a DB owner (user_id) of anything, but is a real
            // member of team B -- proving the ON-path switches the trusted
            // dimension from user_id to team membership.
            const actorTeamBOnly = buildActor(
                { userId: userB, isSuperadmin: false },
                [{ teamId: teamB, roleSlug: "viewer" }],
                teamB
            );
            const socket = makeSocket(userB, actorTeamBOnly);

            const list = await sendNotificationList(socket);
            assert.strictEqual(list.length, 1);
            assert.strictEqual(list[0].name, "notif-B");
        });

        test("an actor who is a member of team A only sees team A's docker hosts", async () => {
            const actorTeamAOnly = buildActor(
                { userId: userA, isSuperadmin: false },
                [{ teamId: teamA, roleSlug: "viewer" }],
                teamA
            );
            const socket = makeSocket(userA, actorTeamAOnly);

            const list = await sendDockerHostList(socket);
            assert.strictEqual(list.length, 1);
            assert.strictEqual(list[0].name, "docker-A");
        });

        test("a member of both teams sees rows from both teams", async () => {
            const actorBoth = buildActor(
                { userId: userA, isSuperadmin: false },
                [
                    { teamId: teamA, roleSlug: "viewer" },
                    { teamId: teamB, roleSlug: "viewer" },
                ],
                teamA
            );
            const socket = makeSocket(userA, actorBoth);

            const list = await sendProxyList(socket);
            assert.strictEqual(list.length, 2);
        });

        test("an actor with no memberships sees nothing, even though user_id would have matched", async () => {
            const actorNoTeams = buildActor({ userId: userA, isSuperadmin: false }, []);
            const socket = makeSocket(userA, actorNoTeams);

            const list = await sendAPIKeyList(socket);
            assert.strictEqual(list.length, 0, "tenant isolation: team membership is required, user_id is not enough");
        });

        test("a superadmin sees every remote_browser row across both teams", async () => {
            const superadmin = buildActor({ userId: userA, isSuperadmin: true }, []);
            const socket = makeSocket(userA, superadmin);

            const list = await sendRemoteBrowserList(socket);
            assert.strictEqual(list.length, 2);
        });
    });
});
