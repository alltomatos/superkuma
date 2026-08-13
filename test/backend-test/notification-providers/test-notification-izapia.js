const { describe, test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const Izapia = require("../../../server/notification-providers/izapia");
const { verifySignature, extractButtonReplyId, extractQuotedReply } = require("../../../server/izapia-callback-helpers");

describe("Izapia.extractMessageId()", () => {
    test("reads message_id from the IZAPIA {ok,data} envelope", () => {
        const id = Izapia.extractMessageId({ data: { ok: true, data: { message_id: "3EB0F355A97E22C6A02792" } } });
        assert.strictEqual(id, "3EB0F355A97E22C6A02792");
    });

    test("returns null for a bare (non-enveloped) message_id -- the exact bug from PR #91", () => {
        const id = Izapia.extractMessageId({ data: { message_id: "3EB0F355A97E22C6A02792" } });
        assert.strictEqual(id, null);
    });

    test("returns null for a falsy response", () => {
        assert.strictEqual(Izapia.extractMessageId(null), null);
        assert.strictEqual(Izapia.extractMessageId(undefined), null);
    });
});

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

describe("Izapia.renderMessage()", () => {
    const provider = new Izapia();
    const monitorJSON = { name: "API Principal" };
    const heartbeatJSON = { status: 0, msg: "Connection refused", localDateTime: "2026-08-12 22:23:15" };

    test("substitutes {monitorName}/{status}/{time}/{msg} from a custom template", () => {
        const notification = { izapiaTemplateBody: "Situação: [{status}]\nAtivo: {monitorName}\nMensagem: {msg}" };
        const text = provider.renderMessage(notification, "fallback", monitorJSON, heartbeatJSON);
        assert.strictEqual(text, "Situação: [Down]\nAtivo: API Principal\nMensagem: Connection refused");
    });

    test("falls back to the generic msg when there is no template", () => {
        const text = provider.renderMessage({}, "fallback msg", monitorJSON, heartbeatJSON);
        assert.strictEqual(text, "fallback msg");
    });

    test("falls back to the generic msg when there is no monitor/heartbeat context (e.g. testNotification)", () => {
        const notification = { izapiaTemplateBody: "Ativo: {monitorName}" };
        assert.strictEqual(provider.renderMessage(notification, "IZapia Testing", null, null), "IZapia Testing");
    });

    test("maps every status code to its template text", () => {
        const notification = { izapiaTemplateBody: "{status}" };
        assert.strictEqual(provider.renderMessage(notification, "x", monitorJSON, { status: 0 }), "Down");
        assert.strictEqual(provider.renderMessage(notification, "x", monitorJSON, { status: 1 }), "Up");
        assert.strictEqual(provider.renderMessage(notification, "x", monitorJSON, { status: 2 }), "Pending");
        assert.strictEqual(provider.renderMessage(notification, "x", monitorJSON, { status: 3 }), "Maintenance");
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
    test("reads data.selected.id from a message.interactiveReply event", () => {
        const id = extractButtonReplyId({
            type: "message.interactiveReply",
            data: { selected: { id: "pause:12" } },
        });
        assert.strictEqual(id, "pause:12");
    });

    test("ignores other event types even if data.selected.id is present", () => {
        const id = extractButtonReplyId({
            type: "message.received",
            data: { selected: { id: "pause:12" } },
        });
        assert.strictEqual(id, null);
    });

    test("returns null when data.selected.id is missing", () => {
        assert.strictEqual(extractButtonReplyId({ type: "message.interactiveReply", data: {} }), null);
    });

    test("returns null for a falsy payload", () => {
        assert.strictEqual(extractButtonReplyId(null), null);
    });
});

describe("izapia-callback-helpers.extractQuotedReply()", () => {
    test("reads stanzaID and text from a quoted message.received event", () => {
        const result = extractQuotedReply({
            type: "message.received",
            data: {
                raw: {
                    extendedTextMessage: {
                        text: "Pausar monitor",
                        contextInfo: { stanzaID: "3EB0162C84262A012C2670" },
                    },
                },
            },
        });
        assert.deepStrictEqual(result, { quotedMessageId: "3EB0162C84262A012C2670", text: "Pausar monitor" });
    });

    test("returns null for a non-quoted message.received event", () => {
        const result = extractQuotedReply({
            type: "message.received",
            data: { raw: { conversation: "just a normal message" } },
        });
        assert.strictEqual(result, null);
    });

    test("ignores other event types", () => {
        const result = extractQuotedReply({
            type: "message.ack",
            data: { raw: { extendedTextMessage: { contextInfo: { stanzaID: "x" } } } },
        });
        assert.strictEqual(result, null);
    });

    test("returns null for a falsy payload", () => {
        assert.strictEqual(extractQuotedReply(null), null);
    });
});
