const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const { nanoid } = require("nanoid");
const { passwordStrength } = require("check-password-strength");
const passwordHash = require("../password-hash");
const mailer = require("../mailer");
const { requirePermission, ForbiddenError } = require("../security/authz");
const { z } = require("zod");
const { validate } = require("../validation");
const TranslatableError = require("../translatable-error");

// bcrypt (via bcryptjs) only uses the first ~72 UTF-8 bytes of its input --
// anything past that is silently ignored, so two passwords that differ only
// after that point hash identically. Reject upfront rather than letting an
// admin believe they set a long/multi-byte password that was quietly
// truncated with no error anywhere in the flow.
const passwordField = z
    .string()
    .min(1)
    .max(255)
    .refine((pw) => Buffer.byteLength(pw, "utf8") <= 72, {
        message: "Password is too long for bcrypt (max 72 bytes once UTF-8 encoded).",
    });

const addUserSchema = z.object({
    username: z.string().trim().min(1).max(255),
    email: z.string().trim().email().max(255),
    password: passwordField.optional(),
});

const resendWelcomeSchema = z.object({
    id: z.number().int().positive(),
});

const setUserPasswordSchema = z.object({
    id: z.number().int().positive(),
    password: passwordField,
    sendEmail: z.boolean().optional().default(false),
});

/**
 * Email a user's login credentials to them. Used both when an account is
 * created and when an admin resends/reissues credentials for an existing
 * account -- the credentials block and password-change reminder stay
 * identical so the two flows can't drift in wording; only the subject and
 * opening line differ.
 * @param {string} username Username shown in the email
 * @param {string} email Recipient address
 * @param {string} password Plaintext password to include
 * @param {string} subject Email subject line
 * @param {string} intro Opening sentence, before the credentials block
 * @returns {Promise<void>} Resolves once the email has been sent
 * @throws {Error} If sending fails (see mailer.sendMail)
 */
async function sendCredentialsEmail(username, email, password, subject, intro) {
    await mailer.sendMail({
        to: email,
        subject,
        text: `Olá ${username},\n\n${intro}\n\nUsuário: ${username}\nSenha: ${password}\n\nRecomendamos alterar sua senha após o primeiro acesso.`,
    });
}

/**
 * Refuse to let a non-superadmin actor change a superadmin's credentials.
 * The "user:manage" permission is coarse (and, under RBAC's dark-launch
 * default per ADR-0010, a no-op that allows every authenticated actor) --
 * without this check, any caller reaching resendWelcome/setUserPassword
 * could silently take over the superadmin account.
 * @param {object} actor The calling actor (socket.actor)
 * @param {object} targetUser The user bean about to have its credentials changed
 * @returns {void}
 * @throws {ForbiddenError} If a non-superadmin actor targets a superadmin user
 */
function assertCanModifyCredentials(actor, targetUser) {
    if (targetUser.is_superadmin && !(actor && actor.isSuperadmin)) {
        throw new ForbiddenError("Only a superadmin can change another superadmin's credentials.");
    }
}

/**
 * Handlers for admin-driven user management (creating additional users).
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.userSocketHandler = (socket) => {
    // Create a new user and email them their credentials
    socket.on("addUser", async (userInput, callback) => {
        try {
            checkLogin(socket);
            requirePermission(socket.actor, "user:manage", {});

            const data = validate(addUserSchema, userInput);

            let password = data.password;
            if (password) {
                if (passwordStrength(password).value === "Too weak") {
                    throw new TranslatableError("passwordTooWeak");
                }
            } else {
                // No password supplied: generate a strong random one and send
                // it to the user by email, since nobody else will know it.
                password = nanoid(16);
            }

            let user = R.dispense("user");
            user.username = data.username;
            user.email = data.email;
            user.password = await passwordHash.generate(password);
            user.is_superadmin = false;

            try {
                await R.store(user);
            } catch (e) {
                throw new Error("A user with this username already exists.");
            }

            log.debug("user", `Added User: ${user.id}`);

            let emailSent = true;
            try {
                await sendCredentialsEmail(
                    data.username,
                    data.email,
                    password,
                    "Sua conta no SuperKuma foi criada",
                    "Sua conta no SuperKuma foi criada."
                );
            } catch (e) {
                emailSent = false;
                log.error("user", `Failed to send welcome email to user ${user.id}: ${e.message}`);
            }

            callback({
                ok: true,
                msg: emailSent ? "successAdded" : "userAddedEmailFailed",
                msgi18n: true,
                userID: user.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
                msgi18n: !!e.msgi18n,
            });
        }
    });

    socket.on("getUserList", async (callback) => {
        try {
            checkLogin(socket);
            requirePermission(socket.actor, "user:manage", {});

            const list = await R.getAll("SELECT id, username, email, is_superadmin FROM user ORDER BY id");

            callback({
                ok: true,
                userList: list,
            });
        } catch (e) {
            log.error("user", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Issue a fresh password for an existing user and email it to them. The
    // original password can never be recovered (it's stored as a bcrypt
    // hash) -- "resend" necessarily means "reissue". The email is sent
    // BEFORE the new password is persisted, so if SMTP is broken the user's
    // working password is left untouched instead of being silently replaced
    // with one nobody received.
    socket.on("resendWelcome", async (input, callback) => {
        try {
            checkLogin(socket);
            requirePermission(socket.actor, "user:manage", {});

            const { id } = validate(resendWelcomeSchema, input);

            const user = await R.findOne("user", "id = ?", [id]);
            if (!user) {
                throw new Error("User not found.");
            }
            assertCanModifyCredentials(socket.actor, user);
            if (!user.email) {
                throw new TranslatableError("userHasNoEmail");
            }

            const newPassword = nanoid(16);

            try {
                await sendCredentialsEmail(
                    user.username,
                    user.email,
                    newPassword,
                    "Suas credenciais de acesso ao SuperKuma foram reenviadas",
                    "Uma nova senha foi gerada para sua conta no SuperKuma."
                );
            } catch (e) {
                log.error("user", `Failed to resend welcome email to user ${user.id}: ${e.message}`);
                throw new TranslatableError("resendWelcomeEmailFailed");
            }

            user.password = await passwordHash.generate(newPassword);
            await R.store(user);

            log.debug("user", `Resent welcome email: ${user.id}`);

            callback({
                ok: true,
                msg: "welcomeEmailResent",
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

    // Set an existing user's password to an admin-chosen value (as opposed
    // to resendWelcome's random-and-emailed reissue). Unlike resendWelcome,
    // the password is persisted immediately: the admin already knows the
    // value they typed, so there's no "nobody received it" risk to guard
    // against by delaying the write. Notifying the user by email is
    // optional and best-effort -- a manually-set password is often meant to
    // be communicated out of band (in person, chat, phone).
    socket.on("setUserPassword", async (input, callback) => {
        try {
            checkLogin(socket);
            requirePermission(socket.actor, "user:manage", {});

            const { id, password, sendEmail } = validate(setUserPasswordSchema, input);

            const user = await R.findOne("user", "id = ?", [id]);
            if (!user) {
                throw new Error("User not found.");
            }
            assertCanModifyCredentials(socket.actor, user);

            if (passwordStrength(password).value === "Too weak") {
                throw new TranslatableError("passwordTooWeak");
            }

            user.password = await passwordHash.generate(password);
            await R.store(user);

            log.debug("user", `Password set by admin: ${user.id}`);

            // Three distinct outcomes for the (optional) notification, so the
            // admin-facing message always matches the real cause instead of
            // conflating "no email on file" with "SMTP send failed".
            let emailStatus = "skipped";
            if (sendEmail) {
                if (!user.email) {
                    emailStatus = "noEmail";
                } else {
                    try {
                        await sendCredentialsEmail(
                            user.username,
                            user.email,
                            password,
                            "Sua senha no SuperKuma foi alterada",
                            "Um administrador definiu uma nova senha para sua conta no SuperKuma."
                        );
                        emailStatus = "sent";
                    } catch (e) {
                        log.error("user", `Failed to email the new password to user ${user.id}: ${e.message}`);
                        emailStatus = "failed";
                    }
                }
            }

            const msgByEmailStatus = {
                skipped: "userPasswordSet",
                sent: "userPasswordSet",
                noEmail: "userPasswordSetNoEmailOnFile",
                failed: "userPasswordSetEmailFailed",
            };

            callback({
                ok: true,
                msg: msgByEmailStatus[emailStatus],
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
