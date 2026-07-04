const { describe, test } = require("node:test");
const assert = require("node:assert");

const {
    checkStatusCode,
    getTotalClientInRoom,
    allowDevAllOrigin,
    allowAllOrigin,
    wait,
    fsExists,
    commandExists,
} = require("../../server/util-server");

describe("misc.js: checkStatusCode()", () => {
    test("returns false when acceptedCodes is null", () => {
        assert.strictEqual(checkStatusCode(200, null), false);
    });

    test("returns false when acceptedCodes is empty", () => {
        assert.strictEqual(checkStatusCode(200, []), false);
    });

    test("matches an exact single status code", () => {
        assert.strictEqual(checkStatusCode(200, ["200"]), true);
        assert.strictEqual(checkStatusCode(201, ["200"]), false);
    });

    test("matches an inclusive status code range", () => {
        assert.strictEqual(checkStatusCode(200, ["200-299"]), true);
        assert.strictEqual(checkStatusCode(299, ["200-299"]), true);
        assert.strictEqual(checkStatusCode(404, ["200-299"]), false);
    });

    test("matches when any range in the accepted list matches", () => {
        assert.strictEqual(checkStatusCode(404, ["200-299", "400-499"]), true);
    });

    test("ignores non-string entries in acceptedCodes and does not throw", () => {
        assert.strictEqual(checkStatusCode(200, [123]), false);
    });

    test("ignores malformed range strings and does not throw", () => {
        assert.strictEqual(checkStatusCode(200, ["a-b-c"]), false);
    });
});

describe("misc.js: getTotalClientInRoom()", () => {
    test("returns 0 when io.sockets is falsy", () => {
        assert.strictEqual(getTotalClientInRoom({}, "any-room"), 0);
    });

    test("returns 0 when sockets.adapter is falsy", () => {
        assert.strictEqual(getTotalClientInRoom({ sockets: {} }, "any-room"), 0);
    });

    test("returns 0 when the room does not exist", () => {
        const io = { sockets: { adapter: { rooms: new Map() } } };
        assert.strictEqual(getTotalClientInRoom(io, "missing-room"), 0);
    });

    test("returns the room's client count when the room exists", () => {
        const io = {
            sockets: {
                adapter: {
                    rooms: new Map([["room1", new Set(["client-a", "client-b", "client-c"])]]),
                },
            },
        };
        assert.strictEqual(getTotalClientInRoom(io, "room1"), 3);
    });
});

describe("misc.js: allowAllOrigin()", () => {
    test("always sets permissive CORS headers", () => {
        const headers = {};
        const fakeRes = {
            header: (key, value) => {
                headers[key] = value;
            },
        };

        allowAllOrigin(fakeRes);

        assert.strictEqual(headers["Access-Control-Allow-Origin"], "*");
        assert.strictEqual(headers["Access-Control-Allow-Methods"], "GET, PUT, POST, DELETE, OPTIONS");
        assert.strictEqual(headers["Access-Control-Allow-Headers"], "Origin, X-Requested-With, Content-Type, Accept");
    });
});

describe("misc.js: allowDevAllOrigin()", () => {
    const originalNodeEnv = process.env.NODE_ENV;

    test("sets CORS headers when NODE_ENV is development", (t) => {
        t.after(() => {
            process.env.NODE_ENV = originalNodeEnv;
        });
        process.env.NODE_ENV = "development";

        const headers = {};
        const fakeRes = {
            header: (key, value) => {
                headers[key] = value;
            },
        };

        allowDevAllOrigin(fakeRes);

        assert.strictEqual(headers["Access-Control-Allow-Origin"], "*");
    });

    test("does not set CORS headers when NODE_ENV is not development", (t) => {
        t.after(() => {
            process.env.NODE_ENV = originalNodeEnv;
        });
        process.env.NODE_ENV = "production";

        const headers = {};
        const fakeRes = {
            header: (key, value) => {
                headers[key] = value;
            },
        };

        allowDevAllOrigin(fakeRes);

        assert.deepStrictEqual(headers, {});
    });
});

describe("misc.js: wait()", () => {
    test("blocks synchronously for approximately the requested duration", () => {
        const start = Date.now();
        wait(50);
        const elapsed = Date.now() - start;
        assert.ok(elapsed >= 45, `Expected to wait at least ~45ms, only waited ${elapsed}ms`);
    });

    test("returns immediately (approximately) for a 0ms wait", () => {
        const start = Date.now();
        wait(0);
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 100, `Expected near-immediate return, took ${elapsed}ms`);
    });
});

describe("misc.js: fsExists()", () => {
    test("resolves true for a file that exists", async () => {
        const result = await fsExists(__filename);
        assert.strictEqual(result, true);
    });

    test("resolves false for a file that does not exist", async () => {
        const result = await fsExists("./this-file-should-never-exist-abc123.tmp");
        assert.strictEqual(result, false);
    });
});

describe("misc.js: commandExists()", () => {
    test("resolves true for a command that exists (node)", async () => {
        const result = await commandExists("node");
        assert.strictEqual(result, true);
    });

    test("resolves false for a command that does not exist", async () => {
        const result = await commandExists("this-command-should-never-exist-xyz-987");
        assert.strictEqual(result, false);
    });
});
