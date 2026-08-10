const { describe, test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const Izapia = require("../../../server/notification-providers/izapia");
const { verifySignature, extractButtonReplyId } = require("../../../server/izapia-callback-helpers");

describe("Izapia.resolveJid()", () => {
    const provider = new Izapia();

    test("appends @s.whatsapp.net for a contact number", () => {
        assert.strictEqual(provider.resolveJid("5511987654321", "contact"), "5511987654321@s.whatsapp.net");
    });

    test("appends @g.us for a group id", () => {
        assert.strictEqual(provider.resolveJid("123456789012345678", "group"), "123456789012345678@g.us");
    });

    test("leaves an already-qualified JID untouched", () => {
        assert.strictEqual(
            provider.resolveJid("5511987654321@s.whatsapp.net", "contact"),
            "5511987654321@s.whatsapp.net"
        );
    });
});

describe("izapia-callback-helpers.verifySignature()", () => {
    const secret = "test-secret";
    const rawBody = Buffer.from(JSON.stringify({ sid: "abc" }));
    const validSignature = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    test("accepts a valid signature", () => {
        assert.strictEqual(verifySignature(secret, rawBody, validSignature), true);
    });

    test("accepts a valid signature without the sha256= prefix", () => {
        assert.strictEqual(verifySignature(secret, rawBody, validSignature.slice(7)), true);
    });

    test("rejects a tampered body", () => {
        assert.strictEqual(verifySignature(secret, Buffer.from(JSON.stringify({ sid: "xyz" })), validSignature), false);
    });

    test("rejects a wrong secret", () => {
        assert.strictEqual(verifySignature("wrong-secret", rawBody, validSignature), false);
    });

    test("rejects a missing signature header", () => {
        assert.strictEqual(verifySignature(secret, rawBody, null), false);
    });
});

describe("izapia-callback-helpers.extractButtonReplyId()", () => {
    test("reads message.buttonReply.id", () => {
        const id = extractButtonReplyId({ message: { buttonReply: { id: "pause:12" } } });
        assert.strictEqual(id, "pause:12");
    });

    test("reads data.interactive.button_reply.id", () => {
        const id = extractButtonReplyId({ data: { interactive: { button_reply: { id: "resume:3" } } } });
        assert.strictEqual(id, "resume:3");
    });

    test("returns null when no known shape matches", () => {
        assert.strictEqual(extractButtonReplyId({ text: "hello" }), null);
    });
});
