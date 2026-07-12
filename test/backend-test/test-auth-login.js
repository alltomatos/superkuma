process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const passwordHash = require("../../server/password-hash");
const { login } = require("../../server/auth");

const testDb = new TestDB("./data/test-auth-login");

let userCounter = 0;

/**
 * Create a fresh, active user with a known password.
 * @param {string} password The plaintext password to hash and store
 * @returns {Promise<object>} The stored user bean
 */
async function createUser(password) {
    userCounter += 1;
    const bean = R.dispense("user");
    bean.username = `auth-login-user-${userCounter}`;
    bean.password = await passwordHash.generate(password);
    bean.active = true;
    await R.store(bean);
    return bean;
}

describe("auth.login (GAP-008)", () => {
    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("a correct username/password logs in successfully", async () => {
        const user = await createUser("correct-horse-battery-staple");

        const result = await login(user.username, "correct-horse-battery-staple");

        assert.ok(result);
        assert.strictEqual(result.id, user.id);
    });

    test("a wrong password on an existing user fails", async () => {
        const user = await createUser("the-real-password");

        const result = await login(user.username, "wrong-password");

        assert.strictEqual(result, null);
    });

    test("a nonexistent username fails", async () => {
        const result = await login("no-such-user-at-all", "whatever");

        assert.strictEqual(result, null);
    });

    test("non-string username/password are rejected without touching the DB", async () => {
        assert.strictEqual(await login(undefined, "pw"), null);
        assert.strictEqual(await login("user", undefined), null);
        assert.strictEqual(await login(null, null), null);
    });

    test("passwordHash.verify is invoked even when the username does not exist -- closes a timing side channel that could otherwise enumerate valid usernames", async (t) => {
        const user = await createUser("some-password");

        const verifySpy = t.mock.method(passwordHash, "verify");

        await login(user.username, "wrong-password");
        const callsForExistingUser = verifySpy.mock.callCount();
        assert.ok(callsForExistingUser >= 1, "verify() must be called for an existing user with a wrong password");

        verifySpy.mock.resetCalls();

        await login("definitely-not-a-real-username", "wrong-password");
        const callsForNonexistentUser = verifySpy.mock.callCount();
        assert.strictEqual(
            callsForNonexistentUser,
            callsForExistingUser,
            "verify() must be called the same number of times for a nonexistent username as for an existing one -- " +
                "otherwise a nonexistent username short-circuits before the (slow) bcrypt compare, and the faster " +
                "response time leaks which usernames exist"
        );

        const [, hashArgForNonexistentUser] = verifySpy.mock.calls[0].arguments;
        assert.ok(
            typeof hashArgForNonexistentUser === "string" && hashArgForNonexistentUser.length > 0,
            "verify() must be called with a real (dummy) hash, not an empty/undefined one, for a nonexistent username"
        );
    });
});
