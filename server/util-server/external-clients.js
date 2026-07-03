const { log } = require("../../src/util");
const RadiusClient = require("../radius-client");

const {
    dictionaries: {
        rfc2865: { file, attributes },
    },
} = require("node-radius-utils");

// SASLOptions used in JSDoc
// eslint-disable-next-line no-unused-vars
const { Kafka, SASLOptions } = require("kafkajs");

/**
 * Monitor Kafka using Producer
 * @param {string[]} brokers List of kafka brokers to connect, host and
 * port joined by ':'
 * @param {string} topic Topic name to produce into
 * @param {string} message Message to produce
 * @param {object} options Kafka client options. Contains ssl, clientId,
 * allowAutoTopicCreation and interval (interval defaults to 20,
 * allowAutoTopicCreation defaults to false, clientId defaults to
 * "Uptime-Kuma" and ssl defaults to false)
 * @param {SASLOptions} saslOptions Options for kafka client
 * Authentication (SASL) (defaults to {})
 * @returns {Promise<string>} Status message
 */
exports.kafkaProducerAsync = function (brokers, topic, message, options = {}, saslOptions = {}) {
    return new Promise((resolve, reject) => {
        const {
            interval = 20,
            allowAutoTopicCreation = false,
            ssl = false,
            clientId = "Uptime-Kuma",
            connectionTimeout = 1,
        } = options;

        let connectedToKafka = false;

        const timeoutID = setTimeout(
            () => {
                log.debug("kafkaProducer", "KafkaProducer timeout triggered");
                connectedToKafka = true;
                reject(new Error("Timeout"));
            },
            interval * 1000 * 0.8
        );

        if (saslOptions.mechanism === "None") {
            saslOptions = undefined;
        }

        let client = new Kafka({
            brokers: brokers,
            clientId: clientId,
            sasl: saslOptions,
            retry: {
                retries: 0,
            },
            ssl: ssl,
            connectionTimeout: connectionTimeout * 1000,
        });

        let producer = client.producer({
            allowAutoTopicCreation: allowAutoTopicCreation,
            retry: {
                retries: 0,
            },
        });

        producer
            .connect()
            .then(() => {
                producer
                    .send({
                        topic: topic,
                        messages: [
                            {
                                value: message,
                            },
                        ],
                    })
                    .then((_) => {
                        resolve("Message sent successfully");
                    })
                    .catch((e) => {
                        connectedToKafka = true;
                        producer.disconnect();
                        clearTimeout(timeoutID);
                        reject(new Error("Error sending message: " + e.message));
                    })
                    .finally(() => {
                        connectedToKafka = true;
                        clearTimeout(timeoutID);
                    });
            })
            .catch((e) => {
                connectedToKafka = true;
                producer.disconnect();
                clearTimeout(timeoutID);
                reject(new Error("Error in producer connection: " + e.message));
            });

        producer.on("producer.network.request_timeout", (_) => {
            if (!connectedToKafka) {
                clearTimeout(timeoutID);
                reject(new Error("producer.network.request_timeout"));
            }
        });

        producer.on("producer.disconnect", (_) => {
            if (!connectedToKafka) {
                clearTimeout(timeoutID);
                reject(new Error("producer.disconnect"));
            }
        });
    });
};

/**
 * Query radius server
 * @param {string} hostname Hostname of radius server
 * @param {string} username Username to use
 * @param {string} password Password to use
 * @param {string} calledStationId ID of called station
 * @param {string} callingStationId ID of calling station
 * @param {string} secret Secret to use
 * @param {number} port Port to contact radius server on
 * @param {number} timeout Timeout for connection to use
 * @returns {Promise<any>} Response from server
 */
exports.radius = function (
    hostname,
    username,
    password,
    calledStationId,
    callingStationId,
    secret,
    port = 1812,
    timeout = 2500
) {
    const client = new RadiusClient({
        host: hostname,
        hostPort: port,
        timeout: timeout,
        retries: 1,
        dictionaries: [file],
    });

    return client
        .accessRequest({
            secret: secret,
            attributes: [
                [attributes.USER_NAME, username],
                [attributes.USER_PASSWORD, password],
                [attributes.CALLING_STATION_ID, callingStationId],
                [attributes.CALLED_STATION_ID, calledStationId],
            ],
        })
        .catch((error) => {
            // Preserve error stack trace and provide better context
            if (error.response?.code) {
                const radiusError = new Error(`RADIUS ${error.response.code} from ${hostname}:${port}`);
                radiusError.response = error.response;
                radiusError.originalError = error;
                throw radiusError;
            } else {
                // Preserve original error message and stack trace
                const enhancedError = new Error(
                    `RADIUS authentication failed for ${hostname}:${port}: ${error.message}`
                );
                enhancedError.originalError = error;
                enhancedError.stack = error.stack || enhancedError.stack;
                throw enhancedError;
            }
        });
};
