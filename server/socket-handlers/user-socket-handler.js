const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const { nanoid } = require("nanoid");
const { passwordStrength } = require("check-password-strength");
const passwordHash = require("../password-hash");
const mailer = require("../mailer");
const { requirePermission } = require("../security/authz");
const { z } = require("zod");
const { validate } = require("../validation");
const TranslatableError = require("../translatable-error");

const addUserSchema = z.object({
    username: z.string().trim().min(1).max(255),
    email: z.string().trim().email().max(255),
    password: z.string().max(255).optional(),
});

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
                await mailer.sendMail({
                    to: data.email,
                    subject: "Sua conta no SuperKuma foi criada",
                    text: `Olá ${data.username},\n\nSua conta no SuperKuma foi criada.\n\nUsuário: ${data.username}\nSenha: ${password}\n\nRecomendamos alterar sua senha após o primeiro acesso.`,
                });
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
};
