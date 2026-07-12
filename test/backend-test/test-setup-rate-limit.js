process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { KumaRateLimiter } = require("../../server/rate-limiter");

describe("setup rate limit (GAP-008)", () => {
    // A real end-to-end test would spawn a full server child process and drive
    // it over socket.io -- deliberately NOT done here. This repo's pre-push
    // hook (.husky/pre-push) explicitly documents that "heavy/flaky
    // server-boot tests were removed" from this suite to keep it
    // deterministic; a first attempt at this exact test did exactly that and
    // reliably hung for 50+ minutes under the full suite's parallel
    // contention (a real server cold-boot -- fresh SQLite + every migration --
    // competing with ~190 other suites), even though it passed cleanly in
    // isolation and under lighter manual contention. That's precisely the
    // flakiness class the project's own convention avoids, so instead this
    // tests the two things that actually matter, both deterministically and
    // without any process/network I/O:

    test("loginRateLimiter's token bucket rejects the 21st rapid call", async () => {
        // A fresh instance with the exact config server/rate-limiter.js uses
        // for the shared loginRateLimiter (tokensPerInterval: 20,
        // fireImmediately: true) -- fireImmediately means all 20 tokens are
        // available up front, so 21 rapid calls deterministically exhaust the
        // budget on the 21st, no real time delay needed.
        const limiter = new KumaRateLimiter({
            tokensPerInterval: 20,
            interval: "minute",
            fireImmediately: true,
            errorMessage: "Too frequently, try again later.",
        });

        const results = [];
        for (let i = 0; i < 21; i++) {
            // eslint-disable-next-line no-await-in-loop -- must be strictly
            // sequential: each call consumes a token, so ordering matters.
            results.push(await limiter.pass());
        }

        assert.strictEqual(results.filter((ok) => ok === true).length, 20, "the first 20 calls should pass");
        assert.strictEqual(results[20], false, "the 21st rapid call must be rejected");
    });

    test("the setup socket handler guards on loginRateLimiter.pass() before doing any work", () => {
        // Characterization/wiring check: confirms server.js's setup handler
        // actually calls the rate limiter (GAP-008) -- without booting a
        // server. Scoped to just the setup handler's body (from its
        // registration to the next socket.on(...)) so this can't accidentally
        // match the guard in a different handler (login/loginByApiKey/2FA
        // already have their own).
        const serverJs = fs.readFileSync(path.join(__dirname, "..", "..", "server", "server.js"), "utf8");
        const start = serverJs.indexOf('socket.on("setup"');
        assert.ok(start !== -1, 'could not find socket.on("setup", ...) in server.js -- did the handler move?');
        const nextHandler = serverJs.indexOf("socket.on(", start + 1);
        const setupHandlerBody = serverJs.slice(start, nextHandler === -1 ? undefined : nextHandler);

        assert.match(
            setupHandlerBody,
            /loginRateLimiter\.pass\(callback\)/,
            "the setup handler must guard on loginRateLimiter.pass(callback) -- same idiom as login/loginByApiKey"
        );
    });
});
