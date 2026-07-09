const nodemailer = require("nodemailer");
const util = require("util");
const { Settings } = require("./settings");
const { log } = require("../src/util");

/**
 * Build a nodemailer transporter from a mail-settings object (same shape as
 * the "general" settings' mail* fields). Shared by sendMail (DB-backed) and
 * sendTestMail (tests whatever is currently on the settings form, saved or not).
 * @param {object} mailSettings Mail settings (mailHost, mailPort, mailSecure, mailIgnoreTLSError, mailUsername, mailPassword)
 * @param {object} extra Extra nodemailer transport options to merge in (e.g. debug/logger)
 * @returns {import("nodemailer").Transporter} The configured transporter
 * @throws {Error} If mailHost is not set
 */
function buildTransporter(mailSettings, extra = {}) {
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
        ...extra,
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
 * Build a nodemailer-compatible logger that appends formatted lines to an
 * array instead of printing to the console, mirroring nodemailer's own
 * built-in console logger format (`createDefaultLogger` in
 * nodemailer/lib/shared/index.js) so the captured transcript reads the same
 * way. Nodemailer itself redacts AUTH credentials before they ever reach the
 * logger (replaced with a literal "/* secret *\/" placeholder), so this is
 * safe to return to the client.
 * @returns {{logger: object, lines: string[]}} A bunyan-compatible logger and the array it appends to
 */
function createCapturingLogger() {
    const lines = [];
    const levels = ["trace", "debug", "info", "warn", "error", "fatal"];
    const logger = {};
    for (const level of levels) {
        logger[level] = (entry, message, ...args) => {
            let prefix = "";
            if (entry) {
                if (entry.tnx === "server") {
                    prefix = "S: ";
                } else if (entry.tnx === "client") {
                    prefix = "C: ";
                }
                if (entry.sid) {
                    prefix = `[${entry.sid}] ${prefix}`;
                }
            }
            const formatted = util.format(message, ...args);
            for (const line of formatted.split(/\r?\n/)) {
                lines.push(`${level.toUpperCase()} ${prefix}${line}`);
            }
        };
    }
    return { logger, lines };
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
 * @param {boolean} debug When true, capture the raw SMTP transcript (connection, EHLO, AUTH,
 * MAIL FROM/RCPT TO/DATA, and the server's final accept/reject response) instead of only
 * throwing/resolving -- lets an admin see e.g. a "250 OK" from the relay even when the message
 * never actually reaches the recipient's inbox (a delivery/reputation issue past the relay,
 * not a SuperKuma bug). Auth credentials are never present in this transcript -- nodemailer
 * replaces them with a literal placeholder before logging.
 * @returns {Promise<{logLines: string[]}>} Resolves once the test email has been accepted by the relay
 * @throws {Error} If SMTP is not configured or sending fails; the thrown error carries a
 * `logLines` property with whatever transcript was captured before failing
 */
async function sendTestMail(mailSettings, to, debug = false) {
    const { logger, lines } = debug ? createCapturingLogger() : { logger: undefined, lines: [] };
    const transporter = buildTransporter(mailSettings, debug ? { debug: true, logger } : {});

    try {
        await transporter.sendMail({
            from: mailSettings.mailFrom,
            to,
            subject: "SuperKuma - Teste de SMTP",
            text: "Este é um email de teste do SuperKuma para confirmar que as configurações de SMTP estão funcionando.",
        });
        return { logLines: lines };
    } catch (e) {
        log.error("mailer", `Failed to send test email to ${to}: ${e.message}`);
        e.logLines = lines;
        throw e;
    }
}

/**
 * Verify SMTP connectivity/authentication using settings straight from the
 * settings form (not yet saved), without sending any email -- a quick way to
 * check host/port/auth/TLS before sending an actual test message.
 * @param {object} mailSettings Mail settings from the (possibly unsaved) settings form
 * @returns {Promise<void>} Resolves if the connection and authentication succeed
 * @throws {Error} If SMTP is not configured or the connection/auth check fails
 */
async function verifyConnection(mailSettings) {
    const transporter = buildTransporter(mailSettings);

    try {
        await transporter.verify();
    } catch (e) {
        log.error("mailer", `SMTP connection check failed: ${e.message}`);
        throw e;
    }
}

module.exports = {
    sendMail,
    sendTestMail,
    verifyConnection,
};
