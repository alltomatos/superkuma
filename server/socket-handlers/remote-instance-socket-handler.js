const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const { nanoid } = require("nanoid");
const passwordHash = require("../password-hash");
const { z } = require("zod");
const { validate } = require("../validation");
const { requireResource } = require("../security/authz");
const { teamIdLoader } = require("../security/team-id-loaders");

const remoteInstanceIDSchema = z.number().int().positive();

const addRemoteInstanceSchema = z.object({
    name: z.string().trim().min(1).max(255),
    instanceId: z.string().trim().min(1).max(255),
});

/**
 * Handlers for remote instances (Master-Agent federation)
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.remoteInstanceSocketHandler = (socket) => {
    // Register a new remote instance (agent) and issue it a one-time token
    socket.on("addRemoteInstance", async (remoteInstance, callback) => {
        try {
            checkLogin(socket);

            const data = validate(addRemoteInstanceSchema, remoteInstance);

            let clearSecret = nanoid(40);
            let hashedSecret = await passwordHash.generate(clearSecret);

            let bean = R.dispense("remote_instance");
            bean.instance_id = data.instanceId;
            bean.name = data.name;
            bean.token_hash = hashedSecret;
            bean.active = true;
            bean.user_id = socket.userID;

            try {
                await R.store(bean);
            } catch (e) {
                throw new Error("A remote instance with this instanceId is already registered.");
            }

            log.debug("remote-instance", `Added Remote Instance: ${bean.id}`);

            // Append instance ID to start of token separated by _, used to get
            // the correct hash when verifying the token.
            let formattedToken = "ri" + bean.id + "_" + clearSecret;

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                token: formattedToken,
                remoteInstanceID: bean.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getRemoteInstanceList", async (callback) => {
        try {
            checkLogin(socket);

            let list = await R.find("remote_instance", " user_id = ? ", [socket.userID]);

            callback({
                ok: true,
                remoteInstanceList: list.map((bean) => bean.toJSON()),
            });
        } catch (e) {
            log.error("remote-instance", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteRemoteInstance", async (remoteInstanceID, callback) => {
        try {
            checkLogin(socket);
            remoteInstanceID = validate(remoteInstanceIDSchema, remoteInstanceID);

            await requireResource(
                socket.actor,
                "remote_instance:manage",
                "remote_instance",
                remoteInstanceID,
                teamIdLoader
            );

            log.debug("remote-instance", `Deleted Remote Instance: ${remoteInstanceID} User ID: ${socket.userID}`);

            // Mirrored monitors keep their row (monitor.remote_instance_id is ON
            // DELETE SET NULL), only the remote_instance registration is removed.
            await R.exec("DELETE FROM remote_instance WHERE id = ? AND user_id = ? ", [
                remoteInstanceID,
                socket.userID,
            ]);

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
