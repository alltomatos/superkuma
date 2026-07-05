const NotificationProvider = require("./notification-provider");
const webpush = require("web-push");
const { setting } = require("../util-server");

class Webpush extends NotificationProvider {
    name = "Webpush";

    /**
     * @inheritDoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            const publicVapidKey = await setting("webpushPublicVapidKey");
            const privateVapidKey = await setting("webpushPrivateVapidKey");

            webpush.setVapidDetails("https://github.com/alltomatos/superkuma", publicVapidKey, privateVapidKey);

            const data = JSON.stringify({
                title: "SuperKuma",
                body: msg,
            });

            await webpush.sendNotification(notification.subscription, data);

            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

module.exports = Webpush;
