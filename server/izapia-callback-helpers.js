const crypto = require("crypto");

/**
 * Recompute HMAC-SHA256(secret, rawBody) and timing-safe compare against the
 * X-izapia-Signature header value.
 * @param {string} secret Per-notification webhook secret.
 * @param {Buffer} rawBody Exact bytes of the received POST body.
 * @param {?string} signatureHeader Value of the X-izapia-Signature header.
 * @returns {boolean} True if the signature is valid.
 */
function verifySignature(secret, rawBody, signatureHeader) {
    if (!secret || !signatureHeader) {
        return false;
    }
    const provided = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : signatureHeader;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    const providedBuf = Buffer.from(provided, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (providedBuf.length !== expectedBuf.length) {
        return false;
    }
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Best-effort extraction of the clicked button's id from an IZAPIA webhook
 * event payload. The exact event shape isn't pinned down in the public
 * OpenAPI (it documents the outbound send endpoints, not inbound webhook
 * event bodies), so several plausible shapes are checked.
 * @param {object} payload Parsed webhook JSON body.
 * @returns {?string} The button id (e.g. "pause:12"), or null if not found.
 */
function extractButtonReplyId(payload) {
    if (!payload) {
        return null;
    }
    const candidates = [
        payload.buttonReplyId,
        payload.button_reply_id,
        payload.message?.buttonReply?.id,
        payload.message?.button_reply?.id,
        payload.data?.message?.buttonReply?.id,
        payload.data?.interactive?.button_reply?.id,
        payload.data?.interactive?.buttonReply?.id,
        payload.interactive?.button_reply?.id,
    ];
    return candidates.find((c) => typeof c === "string" && c.length > 0) || null;
}

module.exports = { verifySignature, extractButtonReplyId };
