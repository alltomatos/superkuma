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
const { requireResource, requirePermission } = require("../security/authz");
const { teamIdLoader } = require("../security/team-id-loaders");

const keyIDSchema = z.number().int().positive();

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
            requirePermission(socket.actor, "api_key:manage", {
                teamId: socket.actor ? socket.actor.activeTeamId : null,
            });

            let clearKey = nanoid(40);
            let hashedKey = await passwordHash.generate(clearKey);
            key["key"] = hashedKey;
            let bean = await APIKey.save(key, socket.userID, socket.actor);

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
