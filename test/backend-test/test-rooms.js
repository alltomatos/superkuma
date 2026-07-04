const { describe, test, after } = require("node:test");
const assert = require("node:assert");
const { setEnforcementEnabled } = require("../../server/security/authz");
const { roomFor } = require("../../server/security/rooms");

describe("roomFor (Socket.io room-naming helper, ADR-0010 P4)", () => {
    after(() => setEnforcementEnabled(false));

    test("enforcement OFF (default): returns the legacy per-user room, ignoring teamId", () => {
        assert.strictEqual(roomFor(42, 7), "42");
        assert.strictEqual(roomFor(42, null), "42");
    });

    test("enforcement ON: returns a team-scoped room, ignoring userId", () => {
        setEnforcementEnabled(true);
        try {
            assert.strictEqual(roomFor(42, 7), "team:7");
            assert.strictEqual(roomFor(999, 7), "team:7", "two different users in the same team share one room");
        } finally {
            setEnforcementEnabled(false);
        }
    });

    test("the OFF-path room name is always a string (matches Socket.io's own room-name coercion)", () => {
        assert.strictEqual(typeof roomFor(42, 7), "string");
    });
});
