const { describe, test } = require("node:test");
const assert = require("node:assert");
const { roomFor } = require("../../server/security/rooms");

describe("roomFor (Socket.io room-naming helper, ADR-0010)", () => {
    test("returns a team-scoped room, ignoring userId", () => {
        assert.strictEqual(roomFor(42, 7), "team:7");
        assert.strictEqual(roomFor(999, 7), "team:7", "two different users in the same team share one room");
    });

    test("falls back to the legacy per-user room when no teamId is resolvable", () => {
        assert.strictEqual(roomFor(42, null), "42");
        assert.strictEqual(roomFor(42, undefined), "42");
    });

    test("never collapses two different teamless users into a single shared room", () => {
        assert.notStrictEqual(roomFor(42, null), roomFor(999, null));
    });

    test("the room name is always a string (matches Socket.io's own room-name coercion)", () => {
        assert.strictEqual(typeof roomFor(42, 7), "string");
        assert.strictEqual(typeof roomFor(42, null), "string");
    });
});
