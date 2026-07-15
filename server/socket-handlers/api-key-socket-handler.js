const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const { nanoid } = require("nanoid");
const passwordHash = require("../password-hash");
const apicache = require("../modules/apicache");
const APIKey = require("../model/api_key");
const { Settings } = require("../settings");
const { sendAPIKeyList } = require("../client");
const { z } = require("zod");
const { validate } = require("../validation");
const { requireResource, requirePermission, ForbiddenError } = require("../security/authz");
const { teamIdLoader } = require("../security/team-id-loaders");
const { expandBuiltinRole } = require("../permissions/catalog");

const keyIDSchema = z.number().int().positive();

// The non-superadmin built-in roles an API key can be assigned. "superadmin"
// is deliberately excluded -- an API key must never carry is_superadmin, even
// indirectly (ADR-0010 R2; see the JSDoc on APIKey.save).
const ASSIGNABLE_API_KEY_ROLE_SLUGS = ["owner", "admin", "editor", "viewer"];

const editAPIKeySchema = z.object({
    id: keyIDSchema,
    roleSlug: z.enum(ASSIGNABLE_API_KEY_ROLE_SLUGS),
});

/**
 * Assert the actor may grant `roleSlug` on an API key in the given team --
 * i.e. the actor's own effective permission set already covers everything
 * that role would grant. Prevents a merely-privileged admin from minting a
 * key that outranks them. Superadmins bypass this (they can grant anything).
 * @param {import("../security/authz").Actor} actor The actor granting the role
 * @param {string} roleSlug Built-in role slug being granted
 * @param {number} teamId The team the grant applies to
 * @returns {void}
 * @throws {ForbiddenError} If the actor's own permissions don't cover the role
 */
function assertCanGrantRole(actor, roleSlug, teamId) {
    if (!actor || actor.isSuperadmin) {
        return;
    }
    const membership = actor.memberships.get(teamId);
    const targetPermissions = expandBuiltinRole(roleSlug);
    const grantsWithinReach =
        membership && [...targetPermissions].every((action) => membership.permissions.has(action));
    if (!grantsWithinReach) {
        throw new ForbiddenError("You cannot grant a role with more permissions than your own.");
    }
}

/**
 * Handlers for API keys
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.apiKeySocketHandler = (socket) => {
    // Add a new api key
    socket.on("addAPIKey", async (key, callback) => {
        try {
            checkLogin(socket);
            const teamId = socket.actor ? socket.actor.activeTeamId : null;
            requirePermission(socket.actor, "api_key:manage", { teamId });

            const roleSlug = key.roleSlug === undefined || key.roleSlug === null ? "viewer" : key.roleSlug;
            if (!ASSIGNABLE_API_KEY_ROLE_SLUGS.includes(roleSlug)) {
                throw new Error("Invalid role");
            }
            assertCanGrantRole(socket.actor, roleSlug, teamId);

            let clearKey = nanoid(40);
            let hashedKey = await passwordHash.generate(clearKey);
            key["key"] = hashedKey;
            let bean = await APIKey.save(key, socket.userID, socket.actor, roleSlug);

            log.debug("apikeys", "Added API Key");
            log.debug("apikeys", key);

            // Append key ID and prefix to start of key separated by _, used to get
            // correct hash when validating key.
            let formattedKey = "uk" + bean.id + "_" + clearKey;
            await sendAPIKeyList(socket);

            // Enable API auth if the user creates a key, otherwise only basic
            // auth will be used for API.
            await Settings.set("apiKeysEnabled", true);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                key: formattedKey,
                keyID: bean.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getAPIKeyList", async (callback) => {
        try {
            checkLogin(socket);
            await sendAPIKeyList(socket);
            callback({
                ok: true,
            });
        } catch (e) {
            log.error("apikeys", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Change the role assigned to an existing API key. Restricted to
    // non-superadmin built-in roles, and the caller may never grant a role
    // more privileged than their own effective permissions in that team --
    // otherwise a mere admin could mint a key that outranks them.
    socket.on("editAPIKey", async (input, callback) => {
        try {
            checkLogin(socket);
            const { id: keyID, roleSlug } = validate(editAPIKeySchema, input);

            await requireResource(socket.actor, "api_key:manage", "api_key", keyID, teamIdLoader);

            const keyTeamId = await teamIdLoader("api_key", keyID);
            assertCanGrantRole(socket.actor, roleSlug, keyTeamId);

            const role = await R.findOne("role", "slug = ? AND team_id IS NULL AND is_system = 1", [roleSlug]);
            if (!role) {
                throw new Error("Unknown role");
            }

            log.debug("apikeys", `Edited API Key: ${keyID} -> role "${roleSlug}" User ID: ${socket.userID}`);

            await R.exec("UPDATE api_key SET role_id = ? WHERE id = ? AND user_id = ? ", [
                role.id,
                keyID,
                socket.userID,
            ]);

            apicache.clear();

            callback({
                ok: true,
                msg: "successEdited",
                msgi18n: true,
            });

            await sendAPIKeyList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteAPIKey", async (keyID, callback) => {
        try {
            checkLogin(socket);
            keyID = validate(keyIDSchema, keyID);

            await requireResource(socket.actor, "api_key:manage", "api_key", keyID, teamIdLoader);

            log.debug("apikeys", `Deleted API Key: ${keyID} User ID: ${socket.userID}`);

            await R.exec("DELETE FROM api_key WHERE id = ? AND user_id = ? ", [keyID, socket.userID]);

            apicache.clear();

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });

            await sendAPIKeyList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("disableAPIKey", async (keyID, callback) => {
        try {
            checkLogin(socket);
            keyID = validate(keyIDSchema, keyID);

            await requireResource(socket.actor, "api_key:manage", "api_key", keyID, teamIdLoader);

            log.debug("apikeys", `Disabled Key: ${keyID} User ID: ${socket.userID}`);

            await R.exec("UPDATE api_key SET active = 0 WHERE id = ? AND user_id = ? ", [keyID, socket.userID]);

            apicache.clear();

            callback({
                ok: true,
                msg: "successDisabled",
                msgi18n: true,
            });

            await sendAPIKeyList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("enableAPIKey", async (keyID, callback) => {
        try {
            checkLogin(socket);
            keyID = validate(keyIDSchema, keyID);

            await requireResource(socket.actor, "api_key:manage", "api_key", keyID, teamIdLoader);

            log.debug("apikeys", `Enabled Key: ${keyID} User ID: ${socket.userID}`);

            await R.exec("UPDATE api_key SET active = 1 WHERE id = ? AND user_id = ? ", [keyID, socket.userID]);

            apicache.clear();

            callback({
                ok: true,
                msg: "successEnabled",
                msgi18n: true,
            });

            await sendAPIKeyList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
