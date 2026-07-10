const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { pathExcludedJsonParser } = require("../../server/middleware/path-excluded-json-parser");

/**
 * Real end-to-end coverage for pathExcludedJsonParser() (ADR-0015
 * TASK-A2-4), extracted out of server.js precisely because no existing test
 * boots the real server.js app -- test-telemetry-router-hardening.js builds
 * its OWN isolated express() app mounting only the router, so it never
 * exercises server.js's app-wide middleware chain at all. An adversarial
 * mutation-check found this exact gap: reverting server.js's exclusion back
 * to plain `express.json()` was NOT caught by any existing test. This file
 * closes that gap by driving a real HTTP server through a real socket,
 * mirroring the actual app-wide-parser-then-route-specific-parser ordering
 * server.js/telemetry-router.js use in production.
 */

const EXCLUDED_PATH = "/v1/metrics";
const ROUTE_LIMIT = "2mb";

describe("pathExcludedJsonParser() - real HTTP server, no mocked req/res", () => {
    let server;
    let baseUrl;

    before(async () => {
        const app = express();

        // Mirrors server.js's app-wide registration exactly.
        app.use(pathExcludedJsonParser([EXCLUDED_PATH]));

        // Mirrors telemetry-router.js's own route-specific, larger-limit parser.
        app.post(EXCLUDED_PATH, express.json({ limit: ROUTE_LIMIT }), (request, response) => {
            response.json({ ok: true, receivedBytes: JSON.stringify(request.body).length });
        });

        // A generic OTHER route, deliberately with no route-specific parser of
        // its own -- it relies entirely on the app-wide parser upstream, same
        // as every real route in server.js except /v1/metrics.
        app.post("/some-other-route", (request, response) => {
            response.json({ ok: true, receivedBytes: JSON.stringify(request.body).length });
        });

        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    /**
     * Build a JSON body whose serialized size exceeds the given number of
     * bytes, via a single padding string field.
     * @param {number} minBytes Minimum serialized size in bytes.
     * @returns {object} A JSON-serializable object at least minBytes large.
     */
    function bodyLargerThan(minBytes) {
        return { padding: "x".repeat(minBytes) };
    }

    test("a body between the global 100kb limit and the route's own 2mb limit is ACCEPTED at /v1/metrics (the exclusion works)", async () => {
        const body = bodyLargerThan(150 * 1024); // 150KB: over the 100kb global default, under the 2mb route limit
        const res = await fetch(`${baseUrl}${EXCLUDED_PATH}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        assert.strictEqual(res.status, 200, "the route's own 2mb limit must be the one enforced, not the global 100kb default");
        const json = await res.json();
        assert.strictEqual(json.ok, true);
    });

    test("the SAME oversized body (150kb) sent to a DIFFERENT route is REJECTED by the app-wide 100kb default (every other route is unaffected)", async () => {
        const body = bodyLargerThan(150 * 1024);
        const res = await fetch(`${baseUrl}/some-other-route`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        assert.strictEqual(res.status, 413, "every route besides /v1/metrics must keep the plain express.json() default limit");
    });

    test("a small body is accepted identically on both routes (the exclusion changes ONLY the limit, not parsing correctness)", async () => {
        const body = { hello: "world" };

        const excludedRes = await fetch(`${baseUrl}${EXCLUDED_PATH}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const otherRes = await fetch(`${baseUrl}/some-other-route`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        assert.strictEqual(excludedRes.status, 200);
        assert.strictEqual(otherRes.status, 200);
        assert.deepStrictEqual(await excludedRes.json(), await otherRes.json());
    });

    test("a body over BOTH limits (3mb) is rejected at /v1/metrics too -- the route's own limit is still enforced, just larger", async () => {
        const body = bodyLargerThan(3 * 1024 * 1024);
        const res = await fetch(`${baseUrl}${EXCLUDED_PATH}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        assert.strictEqual(res.status, 413);
    });
});
