const { checkLogin } = require("../util-server");
const mailer = require("../mailer");
const { z } = require("zod");
const { validate } = require("../validation");

const testMailSchema = z.object({
    to: z.string().trim().email().max(255),
    debug: z.boolean().optional().default(false),
});

/**
 * Handlers for mail (SMTP) settings actions that aren't plain get/setSettings.
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.mailSocketHandler = (socket) => {
    // Send a test email to an admin-chosen recipient, using whatever mail*
    // fields are currently on the settings form (not necessarily saved yet),
    // so a configuration can be verified before persisting it.
    socket.on("testMailSettings", async (input, callback) => {
        try {
            checkLogin(socket);

            const { mailSettings } = input;
            const { to, debug } = validate(testMailSchema, input);

            const { logLines } = await mailer.sendTestMail(mailSettings, to, debug);

            callback({
                ok: true,
                msg: { key: "smtpTestSent", values: { to } },
                msgi18n: true,
                logLines,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
                msgi18n: !!e.msgi18n,
                logLines: e.logLines || [],
            });
        }
    });

    // Check SMTP connectivity/authentication only (no email sent) -- a
    // faster, inbox-safe way to confirm host/port/auth/TLS before sending an
    // actual test message.
    socket.on("verifyMailConnection", async (mailSettings, callback) => {
        try {
            checkLogin(socket);

            await mailer.verifyConnection(mailSettings);

            callback({
                ok: true,
                msg: "smtpConnectionOk",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
                msgi18n: !!e.msgi18n,
            });
        }
    });
};
