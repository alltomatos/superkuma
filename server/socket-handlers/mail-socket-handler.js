const { checkLogin } = require("../util-server");
const { R } = require("redbean-node");
const mailer = require("../mailer");
const TranslatableError = require("../translatable-error");

/**
 * Handlers for mail (SMTP) settings actions that aren't plain get/setSettings.
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.mailSocketHandler = (socket) => {
    // Send a test email using whatever mail* fields are currently on the
    // settings form (not necessarily saved yet), so an admin can verify a
    // configuration before persisting it.
    socket.on("testMailSettings", async (mailSettings, callback) => {
        try {
            checkLogin(socket);

            const to =
                (await R.getCell("SELECT email FROM user WHERE id = ?", [socket.userID])) || mailSettings.mailFrom;

            if (!to) {
                throw new TranslatableError("noTestEmailRecipient");
            }

            await mailer.sendTestMail(mailSettings, to);

            callback({
                ok: true,
                msg: { key: "smtpTestSent", values: { to } },
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
