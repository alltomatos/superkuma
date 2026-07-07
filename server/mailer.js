const nodemailer = require("nodemailer");
const { Settings } = require("./settings");
const { log } = require("../src/util");

/**
 * Send an email using the globally configured SMTP settings (Settings.getSettings("general")).
 * @param {object} options Email options
 * @param {string} options.to Recipient address
 * @param {string} options.subject Email subject
 * @param {string} options.text Plain-text body
 * @param {string} options.html Optional HTML body
 * @returns {Promise<void>} Resolves once the email has been sent
 * @throws {Error} If SMTP is not configured or sending fails
 */
async function sendMail({ to, subject, text, html }) {
    const mailSettings = await Settings.getSettings("general");

    if (!mailSettings.mailHost) {
        throw new Error("SMTP not configured");
    }

    const config = {
        host: mailSettings.mailHost,
        port: mailSettings.mailPort,
        secure: mailSettings.mailSecure,
        tls: {
            rejectUnauthorized: !mailSettings.mailIgnoreTLSError,
        },
    };

    if (mailSettings.mailUsername || mailSettings.mailPassword) {
        config.auth = {
            user: mailSettings.mailUsername,
            pass: mailSettings.mailPassword,
        };
    }

    const transporter = nodemailer.createTransport(config);

    try {
        await transporter.sendMail({
            from: mailSettings.mailFrom,
            to,
            subject,
            text,
            html,
        });
    } catch (e) {
        log.error("mailer", `Failed to send email to ${to}: ${e.message}`);
        throw e;
    }
}

module.exports = {
    sendMail,
};
