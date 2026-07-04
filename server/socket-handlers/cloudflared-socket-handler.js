const { checkLogin, setSetting, setting, doubleCheckPassword } = require("../util-server");
const { CloudflaredTunnel } = require("node-cloudflared-tunnel");
const { SuperKumaServer } = require("../uptime-kuma-server");
const { log } = require("../../src/util");
const { z } = require("zod");
const { validate } = require("../validation");
const io = SuperKumaServer.getInstance().io;

const prefix = "cloudflared_";
const cloudflared = new CloudflaredTunnel();

// Cloudflared tunnel tokens are base64-encoded JSON blobs; 5000 chars is
// generously above real-world token sizes. Token remains optional here --
// the "start" handler already treats a falsy/non-string token as "no token"
// (see the `if (token && typeof token === "string")` guard below), so this
// schema must not make it required.
const cloudflaredTokenSchema = z.string().max(5000).nullish();

/**
 * Change running state
 * @param {string} running Is it running?
 * @param {string} message Message to pass
 * @returns {void}
 */
cloudflared.change = (running, message) => {
    io.to("cloudflared").emit(prefix + "running", running);
    io.to("cloudflared").emit(prefix + "message", message);
};

/**
 * Emit an error message
 * @param {string} errorMessage Error message to send
 * @returns {void}
 */
cloudflared.error = (errorMessage) => {
    io.to("cloudflared").emit(prefix + "errorMessage", errorMessage);
};

/**
 * Handler for cloudflared
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.cloudflaredSocketHandler = (socket) => {
    socket.on(prefix + "join", async () => {
        try {
            checkLogin(socket);
            socket.join("cloudflared");
            io.to(socket.userID).emit(prefix + "installed", cloudflared.checkInstalled());
            io.to(socket.userID).emit(prefix + "running", cloudflared.running);
            io.to(socket.userID).emit(prefix + "token", await setting("cloudflaredTunnelToken"));
        } catch (error) {
            log.error("cloudflared", "Error in join handler: " + error.message);
        }
    });

    socket.on(prefix + "leave", async () => {
        try {
            checkLogin(socket);
            socket.leave("cloudflared");
        } catch (error) {
            log.error("cloudflared", "Error in leave handler: " + error.message);
        }
    });

    socket.on(prefix + "start", async (token) => {
        try {
            checkLogin(socket);
            token = validate(cloudflaredTokenSchema, token);
            if (token && typeof token === "string") {
                await setSetting("cloudflaredTunnelToken", token);
                cloudflared.token = token;
            } else {
                cloudflared.token = null;
            }
            cloudflared.start();
        } catch (error) {
            log.error("cloudflared", "Error in start handler: " + error.message);
        }
    });

    socket.on(prefix + "stop", async (currentPassword, callback) => {
        try {
            checkLogin(socket);
            const disabledAuth = await setting("disableAuth");
            if (!disabledAuth) {
                await doubleCheckPassword(socket, currentPassword);
            }
            cloudflared.stop();
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on(prefix + "removeToken", async () => {
        try {
            checkLogin(socket);
            await setSetting("cloudflaredTunnelToken", "");
        } catch (error) {
            log.error("cloudflared", "Error in removeToken handler: " + error.message);
        }
    });
};

/**
 * Automatically start cloudflared
 * @param {string} token Cloudflared tunnel token
 * @returns {Promise<void>}
 */
module.exports.autoStart = async (token) => {
    if (!token) {
        token = await setting("cloudflaredTunnelToken");
    } else {
        // Override the current token via args or env var
        await setSetting("cloudflaredTunnelToken", token);
        log.info("cloudflare", "Use cloudflared token from args or env var");
    }

    if (token) {
        log.info("cloudflare", "Start cloudflared");
        cloudflared.token = token;
        cloudflared.start();
    }
};

/**
 * Stop cloudflared
 * @returns {Promise<void>}
 */
module.exports.stop = async () => {
    log.info("cloudflared", "Stop cloudflared");
    if (cloudflared) {
        cloudflared.stop();
    }
};
