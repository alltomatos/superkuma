const { checkLogin } = require("../util-server");
const { Proxy } = require("../proxy");
const { sendProxyList } = require("../client");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { z } = require("zod");
const { validate } = require("../validation");
const server = UptimeKumaServer.getInstance();

// Username/password are only required by the UI when "auth" is enabled
// (ProxyDialog.vue toggles their <input required> with proxy.auth), but the
// fields are otherwise left as `null` in the form model, so both must stay
// optional/nullable here.
const proxySchema = z
    .object({
        protocol: z.enum(Proxy.SUPPORTED_PROXY_PROTOCOLS),
        host: z.string().min(1).max(255),
        port: z.coerce.number().int().min(1).max(65535),
        auth: z.boolean().nullish(),
        username: z.string().max(255).nullish(),
        password: z.string().max(255).nullish(),
        active: z.boolean().nullish(),
        default: z.boolean().nullish(),
        applyExisting: z.boolean().nullish(),
    })
    .passthrough();

/**
 * Handlers for proxy
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.proxySocketHandler = (socket) => {
    socket.on("addProxy", async (proxy, proxyID, callback) => {
        try {
            checkLogin(socket);
            proxy = validate(proxySchema, proxy);

            const proxyBean = await Proxy.save(proxy, proxyID, socket.userID);
            await sendProxyList(socket);

            if (proxy.applyExisting) {
                await Proxy.reloadProxy();
                await server.sendMonitorList(socket);
            }

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                id: proxyBean.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteProxy", async (proxyID, callback) => {
        try {
            checkLogin(socket);

            await Proxy.delete(proxyID, socket.userID);
            await sendProxyList(socket);
            await Proxy.reloadProxy();

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
