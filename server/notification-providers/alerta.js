const NotificationProvider = require("./notification-provider");
const { DOWN, UP } = require("../../src/util");
const axios = require("axios");

class Alerta extends NotificationProvider {
    name = "alerta";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            let config = {
                headers: {
                    "Content-Type": "application/json;charset=UTF-8",
                    Authorization: "Key " + notification.alertaApiKey,
                },
            };
            let data = {
                environment: notification.alertaEnvironment,
                severity: "critical",
                correlate: [],
                service: ["SuperKuma"],
                value: "Timeout",
                tags: ["superkuma"],
                attributes: {},
                origin: "superkuma",
                type: "exceptionAlert",
            };

            config = this.getAxiosConfigWithProxy(config);

            if (heartbeatJSON == null) {
                let postData = Object.assign(
                    {
                        event: "msg",
                        text: msg,
                        group: "superkuma-msg",
                        resource: "Message",
                    },
                    data
                );

                await axios.post(notification.alertaApiEndpoint, postData, config);
            } else {
                let datadup = Object.assign(
                    {
                        correlate: ["service_up", "service_down"],
                        event: monitorJSON["type"],
                        group: "superkuma-" + monitorJSON["type"],
                        resource: monitorJSON["name"],
                    },
                    data
                );

                if (heartbeatJSON["status"] === DOWN) {
                    datadup.severity = notification.alertaAlertState; // critical
                    datadup.text = "Service " + monitorJSON["type"] + " is down.";
                    await axios.post(notification.alertaApiEndpoint, datadup, config);
                } else if (heartbeatJSON["status"] === UP) {
                    datadup.severity = notification.alertaRecoverState; // cleaned
                    datadup.text = "Service " + monitorJSON["type"] + " is up.";
                    await axios.post(notification.alertaApiEndpoint, datadup, config);
                }
            }
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

module.exports = Alerta;
