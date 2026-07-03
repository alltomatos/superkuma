const { sendRemoteBrowserList } = require("../client");
const { checkLogin } = require("../util-server");
const { RemoteBrowser } = require("../remote-browser");

const { log } = require("../../src/util");
const { testRemoteBrowser } = require("../monitor-types/real-browser-monitor-type");
const { z } = require("zod");
const { validate } = require("../validation");

// RemoteBrowser.url is a Playwright CDP/websocket endpoint
// (chromium.connect(remoteBrowser.url) in real-browser-monitor-type.js), e.g.
// "ws://chrome.browserless.io/playwright?token=..." as shown in
// RemoteBrowserDialog.vue -- so this must accept ws(s):// URLs, not just
// http(s). z.string().url() only checks general URL well-formedness and
// does not restrict the scheme, so ws(s):// values pass.
const remoteBrowserSchema = z.object({
    name: z.string().min(1).max(255),
    url: z.string().min(1).max(2000).url(),
}).passthrough();

// The "Test" button in RemoteBrowserDialog.vue is a plain type="button", so
// it bypasses the form's HTML5 "required" validation and can submit before
// "name" is filled in. testRemoteBrowser() only reads remoteBrowser.url.
const remoteBrowserTestSchema = z.object({
    url: z.string().min(1).max(2000).url(),
}).passthrough();

/**
 * Handlers for docker hosts
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.remoteBrowserSocketHandler = (socket) => {
    socket.on("addRemoteBrowser", async (remoteBrowser, remoteBrowserID, callback) => {
        try {
            checkLogin(socket);
            remoteBrowser = validate(remoteBrowserSchema, remoteBrowser);

            let remoteBrowserBean = await RemoteBrowser.save(remoteBrowser, remoteBrowserID, socket.userID);
            await sendRemoteBrowserList(socket);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                id: remoteBrowserBean.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteRemoteBrowser", async (dockerHostID, callback) => {
        try {
            checkLogin(socket);

            await RemoteBrowser.delete(dockerHostID, socket.userID);
            await sendRemoteBrowserList(socket);

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

    socket.on("testRemoteBrowser", async (remoteBrowser, callback) => {
        try {
            checkLogin(socket);
            remoteBrowser = validate(remoteBrowserTestSchema, remoteBrowser);
            let check = await testRemoteBrowser(remoteBrowser.url);
            log.info("remoteBrowser", "Tested remote browser: " + check);
            let msg;

            if (check) {
                msg = "Connected Successfully.";
            }

            callback({
                ok: true,
                msg,
            });
        } catch (e) {
            log.error("remoteBrowser", e);

            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
