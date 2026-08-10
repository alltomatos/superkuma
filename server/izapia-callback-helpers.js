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
 * Extracts the clicked button's id from an IZAPIA `message.interactiveReply`
 * webhook event (envelope: {event_id, type, session_id, tenant_id, data,
 * published_at}). IZAPIA's own event catalog documents this event
 * normalizing the three raw WhatsApp interactive-reply shapes (legacy
 * button, single_select list, NativeFlow) into `data.selected.id` -- this is
 * believed to be how the official WhatsApp Business Cloud API surfaces a
 * button tap. NOT how a personal/QR-paired session behaves in practice: live
 * testing during this PR (see #91) showed a tapped button on a QR-paired
 * session instead arrives as an ordinary `message.received` text reply
 * quoting the original message -- see extractQuotedReply() below, which is
 * what the router actually relies on today. This function is kept as a
 * forward-compatible fallback in case a Business API session is ever wired
 * up, but is unverified against a live event.
 * @param {object} payload Parsed webhook JSON body (the event envelope).
 * @returns {?string} The button id (e.g. "pause:12"), or null if not found.
 */
function extractButtonReplyId(payload) {
    if (!payload || payload.type !== "message.interactiveReply") {
        return null;
    }
    const id = payload.data?.selected?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Extracts a quoted-reply's original message id (stanzaID) and reply text
 * from an IZAPIA `message.received` webhook event, for a QR-paired
 * (non-Business-API) WhatsApp session. Confirmed live during this PR (#91):
 * tapping an IZAPIA interactive button sends an ordinary text message whose
 * raw WhatsApp payload is `extendedTextMessage` with
 * `contextInfo.stanzaID` set to the id of the message being replied to.
 * @param {object} payload Parsed webhook JSON body (the event envelope).
 * @returns {?{quotedMessageId: string, text: string}} The quoted message id
 *     and reply text, or null if this event isn't a quoted text reply.
 */
function extractQuotedReply(payload) {
    if (!payload || payload.type !== "message.received") {
        return null;
    }
    const extendedText = payload.data?.raw?.extendedTextMessage;
    const quotedMessageId = extendedText?.contextInfo?.stanzaID;
    if (typeof quotedMessageId !== "string" || quotedMessageId.length === 0) {
        return null;
    }
    return { quotedMessageId, text: typeof extendedText.text === "string" ? extendedText.text : "" };
}

module.exports = { verifySignature, extractButtonReplyId, extractQuotedReply };
