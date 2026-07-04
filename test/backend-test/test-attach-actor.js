process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const { nanoid } = require("nanoid");
const passwordHash = require("../../server/password-hash");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { attachActor, requireSuperadmin } = require("../../server/auth");

const testDb = new TestDB("./data/test-attach-actor");

/**
 * Build a minimal Express-like req/res pair and invoke a middleware,
 * resolving once `next()` is called or the response is finalized.
 * @param {object} req A partial Express request object.
 * @param {Function} middleware The middleware under test.
 * @returns {Promise<{req: object, res: object, calledNext: boolean}>} Result.
 */
function runMiddleware(req, middleware) {
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: null,
            body: null,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                this.body = payload;
                resolve({ req, res: this, calledNext: false });
            },
        };
        Promise.resolve(middleware(req, res, () => resolve({ req, res, calledNext: true }))).catch(reject);
    });
}

describe("attachActor + requireSuperadmin (ADR-0010 P4, /metrics gate)", () => {
    let plainUser;
    let superadminUser;
    let teamId;

    before(async () => {
        await testDb.create();

        // The RBAC migration's backfill makes the lowest-id existing user the
        // super admin -- create it FIRST so it's deterministic.
        const superBean = R.dispense("user");
        superBean.username = "attach-actor-super";
        superBean.password = await passwordHash.generate("super-pw");
        superBean.active = true;
        superadminUser = await R.store(superBean);

        const plainBean = R.dispense("user");
        plainBean.username = "attach-actor-plain";
        plainBean.password = await passwordHash.generate("plain-pw");
        plainBean.active = true;
        plainUser = await R.store(plainBean);

        await R.exec("UPDATE `user` SET is_superadmin = 1 WHERE id = ? ", [superadminUser]);

        const teamBean = R.dispense("team");
        teamBean.name = "Attach Actor Team";
        teamBean.slug = "attach-actor-team";
        teamBean.is_system = false;
        teamBean.active = true;
        teamId = await R.store(teamBean);

        const ownerRole = await R.knex("role").whereNull("team_id").andWhere("slug", "owner").first();
        for (const userId of [superadminUser, plainUser]) {
            const membership = R.dispense("team_user");
            membership.team_id = teamId;
            membership.user_id = userId;
            membership.role_id = ownerRole.id;
            await R.store(membership);
        }
    });

    beforeEach(async () => {
        await Settings.set("disableAuth", false);
        await Settings.set("apiKeysEnabled", false);
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    describe("disableAuth mode", () => {
        test("resolves the deterministic active user (lowest id) regardless of req.auth", async () => {
            await Settings.set("disableAuth", true);
            const { req } = await runMiddleware({}, attachActor);
            assert.ok(req.actor, "an actor should be resolved");
            assert.strictEqual(req.actor.userId, superadminUser, "the lowest-id user is resolved deterministically");
            assert.strictEqual(req.actor.isSuperadmin, true);
        });
    });

    describe("basic auth mode (apiKeysEnabled=false)", () => {
        test("valid username/password resolves the matching user's actor", async () => {
            const { req } = await runMiddleware(
                { auth: { user: "attach-actor-plain", pass: "plain-pw" } },
                attachActor
            );
            assert.ok(req.actor);
            assert.strictEqual(req.actor.userId, plainUser);
            assert.strictEqual(req.actor.isSuperadmin, false);
        });

        test("invalid password leaves req.actor null, never throws", async () => {
            const { req } = await runMiddleware(
                { auth: { user: "attach-actor-plain", pass: "wrong-password" } },
                attachActor
            );
            assert.strictEqual(req.actor, null);
        });

        test("missing req.auth (e.g. disableAuth's own bypass path never ran basicAuth) leaves req.actor null", async () => {
            const { req } = await runMiddleware({}, attachActor);
            assert.strictEqual(req.actor, null);
        });
    });

    describe("API key mode (apiKeysEnabled=true)", () => {
        let formattedKey;

        before(async () => {
            const clearKey = nanoid(40);
            const hashedKey = await passwordHash.generate(clearKey);

            const keyBean = R.dispense("api_key");
            keyBean.user_id = plainUser;
            keyBean.team_id = teamId;
            keyBean.name = "Attach Actor Test Key";
            keyBean.key = hashedKey;
            keyBean.active = true;
            keyBean.expires = null;
            const keyId = await R.store(keyBean);

            const viewerRole = await R.knex("role").whereNull("team_id").andWhere("slug", "viewer").first();
            await R.exec("UPDATE api_key SET role_id = ? WHERE id = ? ", [viewerRole.id, keyId]);

            formattedKey = "uk" + keyId + "_" + clearKey;
        });

        beforeEach(async () => {
            await Settings.set("apiKeysEnabled", true);
        });

        test("a valid key resolves an actor capped to its own role, never the key owner's superadmin", async () => {
            const { req } = await runMiddleware({ auth: { user: "any", pass: formattedKey } }, attachActor);
            assert.ok(req.actor);
            assert.strictEqual(req.actor.isSuperadmin, false, "API-key actor must never be superadmin");
            assert.strictEqual(req.actor.userId, plainUser);
        });

        test("an invalid key leaves req.actor null, never throws", async () => {
            const { req } = await runMiddleware(
                { auth: { user: "any", pass: "uk999999_not-a-real-secret" } },
                attachActor
            );
            assert.strictEqual(req.actor, null);
        });
    });

    describe("requireSuperadmin gate", () => {
        test("calls next() when req.actor.isSuperadmin is true", async () => {
            const { calledNext } = await runMiddleware({ actor: { isSuperadmin: true } }, requireSuperadmin);
            assert.strictEqual(calledNext, true);
        });

        test("responds 403 when req.actor is a non-superadmin actor", async () => {
            const { res, calledNext } = await runMiddleware({ actor: { isSuperadmin: false } }, requireSuperadmin);
            assert.strictEqual(calledNext, false);
            assert.strictEqual(res.statusCode, 403);
        });

        test("responds 403 when req.actor is null (attachActor failed to resolve anyone)", async () => {
            const { res, calledNext } = await runMiddleware({ actor: null }, requireSuperadmin);
            assert.strictEqual(calledNext, false);
            assert.strictEqual(res.statusCode, 403);
        });
    });
});
