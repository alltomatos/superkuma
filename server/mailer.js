const nodemailer = require("nodemailer");
const { Settings } = require("./settings");
const { log } = require("../src/util");

/**
 * Build a nodemailer transporter from a mail-settings object (same shape as
 * the "general" settings' mail* fields). Shared by sendMail (DB-backed) and
 * sendTestMail (tests whatever is currently on the settings form, saved or not).
 * @param {object} mailSettings Mail settings (mailHost, mailPort, mailSecure, mailIgnoreTLSError, mailUsername, mailPassword)
 * @returns {import("nodemailer").Transporter} The configured transporter
 * @throws {Error} If mailHost is not set
 */
function buildTransporter(mailSettings) {
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

    return nodemailer.createTransport(config);
}

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
    const transporter = buildTransporter(mailSettings);

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

/**
 * Send a test email using SMTP settings straight from the settings form
 * (not yet saved), so an admin can verify a configuration before persisting it.
 * @param {object} mailSettings Mail settings from the (possibly unsaved) settings form
 * @param {string} to Recipient address for the test email
 * @returns {Promise<void>} Resolves once the test email has been sent
 * @throws {Error} If SMTP is not configured or sending fails
 */
async function sendTestMail(mailSettings, to) {
    const transporter = buildTransporter(mailSettings);

    try {
        await transporter.sendMail({
            from: mailSettings.mailFrom,
            to,
            subject: "SuperKuma - Teste de SMTP",
            text: "Este é um email de teste do SuperKuma para confirmar que as configurações de SMTP estão funcionando.",
        });
    } catch (e) {
        log.error("mailer", `Failed to send test email to ${to}: ${e.message}`);
        throw e;
    }
}

module.exports = {
    sendMail,
    sendTestMail,
};
