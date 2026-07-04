const { sendDockerHostList } = require("../client");
const { checkLogin } = require("../util-server");
const { DockerHost } = require("../docker");
const { log } = require("../../src/util");
const { z } = require("zod");
const { validate } = require("../validation");

// "socket" and "tcp" are the only values DockerHost.testDockerHost() and
// DockerHost.getHttpsAgentOptions() branch on (server/docker.js); anything
// else falls through as an unconfigured request.
const dockerHostSchema = z
    .object({
        name: z.string().min(1).max(255),
        dockerType: z.enum(["socket", "tcp"]),
        dockerDaemon: z.string().min(1).max(1000),
    })
    .passthrough();

// The "Test" button in DockerHostDialog.vue is a plain type="button", so it
// bypasses the form's HTML5 "required" validation and can submit before
// "name" is filled in. testDockerHost() itself only reads dockerType/
// dockerDaemon, so only those need to be validated here.
const dockerHostTestSchema = z
    .object({
        dockerType: z.enum(["socket", "tcp"]),
        dockerDaemon: z.string().min(1).max(1000),
    })
    .passthrough();

/**
 * Handlers for docker hosts
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.dockerSocketHandler = (socket) => {
    socket.on("addDockerHost", async (dockerHost, dockerHostID, callback) => {
        try {
            checkLogin(socket);
            dockerHost = validate(dockerHostSchema, dockerHost);

            let dockerHostBean = await DockerHost.save(dockerHost, dockerHostID, socket.userID);
            await sendDockerHostList(socket);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                id: dockerHostBean.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteDockerHost", async (dockerHostID, callback) => {
        try {
            checkLogin(socket);

            await DockerHost.delete(dockerHostID, socket.userID);
            await sendDockerHostList(socket);

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

    socket.on("testDockerHost", async (dockerHost, callback) => {
        try {
            checkLogin(socket);
            dockerHost = validate(dockerHostTestSchema, dockerHost);

            let amount = await DockerHost.testDockerHost(dockerHost);
            let msg;

            if (amount >= 1) {
                msg = "Connected Successfully. Amount of containers: " + amount;
            } else {
                msg = "Connected Successfully, but there are no containers?";
            }

            callback({
                ok: true,
                msg,
            });
        } catch (e) {
            log.error("docker", e);

            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
