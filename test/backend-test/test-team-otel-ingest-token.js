process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { buildActor } = require("../../server/security/authz");
const { teamSocketHandler } = require("../../server/socket-handlers/team-socket-handler");

/**
 * Minimal mock Socket.io socket: captures `.on(event, handler)` registrations
 * so a test can `.trigger(event, ...args)` them directly, without a real
 * server/transport. checkLogin() only needs socket.userID truthy; the authz
 * layer only needs socket.actor. Mirrors
 * test-notification-route-socket-handler.js's own makeMockSocket().
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
    const slug = `otel-ingest-team-${teamCounter}`;
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
    const username = `otel-ingest-user-${userCounter}`;
    await R.knex("user").insert({ username, password: "x", is_superadmin: !!fields.isSuperadmin });
    return (await R.knex("user").where("username", username).first()).id;
}

/**
 * Build an actor for a user with a single team membership + role, mirroring
 * the fixture idiom in test-notification-route-socket-handler.js.
 * @param {number} userId The user id
 * @param {number} teamId The team id
 * @param {string} roleSlug A built-in role slug ("owner"/"admin"/"editor"/"viewer")
 * @returns {object} An RBAC actor
 */
function actorFor(userId, teamId, roleSlug) {
    return buildActor({ userId, isSuperadmin: false }, [{ teamId, roleSlug }], teamId);
}

describe("team-socket-handler.js regenerateOtelIngestToken (ADR-0015, TASK-A2-5)", () => {
    const testDb = new TestDB("./data/test-team-otel-ingest-token");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("a non-superadmin team owner is denied, and the team's token is left untouched", async () => {
        const teamId = await createTeam();
        const userId = await createUser();
        const socket = makeMockSocket(actorFor(userId, teamId, "owner"), userId);
        teamSocketHandler(socket);

        const before_ = await R.findOne("team", "id = ?", [teamId]);
        assert.strictEqual(before_.otel_ingest_token, null);

        const res = await socket.trigger("regenerateOtelIngestToken", { teamId });

        assert.strictEqual(res.ok, false);
        assert.ok(!res.token, "a denied call must never return a token");

        const after_ = await R.findOne("team", "id = ?", [teamId]);
        assert.strictEqual(after_.otel_ingest_token, null, "token must remain unset after a denied attempt");
    });

    test("a non-superadmin team admin (team:manage NOT in ADMIN_EXTRA) is also denied", async () => {
        const teamId = await createTeam();
        const userId = await createUser();
        const socket = makeMockSocket(actorFor(userId, teamId, "admin"), userId);
        teamSocketHandler(socket);

        const res = await socket.trigger("regenerateOtelIngestToken", { teamId });

        assert.strictEqual(res.ok, false);
        assert.match(res.msg, /superadmin|Permission denied/);
    });

    test("a superadmin can generate a token for a team that has none yet", async () => {
        const teamId = await createTeam();
        const superId = await createUser({ isSuperadmin: true });
        const socket = makeMockSocket(buildActor({ userId: superId, isSuperadmin: true }, []), superId);
        teamSocketHandler(socket);

        const res = await socket.trigger("regenerateOtelIngestToken", { teamId });

        assert.strictEqual(res.ok, true, res.msg);
        assert.strictEqual(typeof res.token, "string");
        assert.strictEqual(res.token.length, 64);

        const stored = await R.findOne("team", "id = ?", [teamId]);
        assert.strictEqual(stored.otel_ingest_token, res.token);
    });

    test("regenerating replaces the token with a different value", async () => {
        const teamId = await createTeam();
        const superId = await createUser({ isSuperadmin: true });
        const socket = makeMockSocket(buildActor({ userId: superId, isSuperadmin: true }, []), superId);
        teamSocketHandler(socket);

        const first = await socket.trigger("regenerateOtelIngestToken", { teamId });
        assert.strictEqual(first.ok, true, first.msg);

        const second = await socket.trigger("regenerateOtelIngestToken", { teamId });
        assert.strictEqual(second.ok, true, second.msg);

        assert.notStrictEqual(second.token, first.token, "regenerating must mint a fresh token, not repeat the old one");

        const stored = await R.findOne("team", "id = ?", [teamId]);
        assert.strictEqual(stored.otel_ingest_token, second.token, "the DB must hold only the newest token");
    });

    test("regenerating for a nonexistent team id returns a clean error, not a crash", async () => {
        const superId = await createUser({ isSuperadmin: true });
        const socket = makeMockSocket(buildActor({ userId: superId, isSuperadmin: true }, []), superId);
        teamSocketHandler(socket);

        const res = await socket.trigger("regenerateOtelIngestToken", { teamId: 999999 });

        assert.strictEqual(res.ok, false);
        assert.match(res.msg, /not found/);
    });

    test("getTeamList reports hasOtelIngestToken presence without ever leaking the token value", async () => {
        const teamId = await createTeam();
        const superId = await createUser({ isSuperadmin: true });
        const socket = makeMockSocket(buildActor({ userId: superId, isSuperadmin: true }, []), superId);
        teamSocketHandler(socket);

        const before_ = await socket.trigger("getTeamList");
        assert.strictEqual(before_.ok, true, before_.msg);
        const beforeRow = before_.teamList.find((t) => t.id === teamId);
        assert.ok(beforeRow, "newly created team must be present in the list");
        assert.ok(!beforeRow.hasOtelIngestToken, "a team with no token must report hasOtelIngestToken falsy");

        const generated = await socket.trigger("regenerateOtelIngestToken", { teamId });
        assert.strictEqual(generated.ok, true, generated.msg);

        const after_ = await socket.trigger("getTeamList");
        const afterRow = after_.teamList.find((t) => t.id === teamId);
        assert.ok(afterRow.hasOtelIngestToken, "a team with a token must report hasOtelIngestToken truthy");
        assert.strictEqual(afterRow.token, undefined, "getTeamList must never carry the token value itself");
    });
});
