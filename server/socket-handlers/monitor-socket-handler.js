const { R } = require("redbean-node");
const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const Monitor = require("../model/monitor");
const Database = require("../database");
const apicache = require("../modules/apicache");
const { z } = require("zod");
const { validate } = require("../validation");
const { requireResource } = require("../security/authz");
const { teamIdLoader } = require("../security/team-id-loaders");

const monitorTagIDSchema = z.number().int().positive();
const monitorTagValueSchema = z.string().max(500).nullish();

/**
 * Authorize the cross-resource ids a client-supplied monitor payload may
 * reference (ADR-0010 §4.4). Each field is resolved against its own resource
 * type via requireResource, which is a no-op while enforcement is OFF. Only
 * fields present and non-null/undefined on the payload are checked.
 * @param {object} actor The acting actor (socket.actor).
 * @param {object} monitor The client-supplied monitor payload.
 * @returns {Promise<void>}
 * @throws {ForbiddenError} If the actor may not read one of the linked resources.
 */
async function validateMonitorLinkedResources(actor, monitor) {
    if (monitor.docker_host !== undefined && monitor.docker_host !== null) {
        await requireResource(actor, "docker_host:read", "docker_host", monitor.docker_host, teamIdLoader);
    }
    if (monitor.proxyId !== undefined && monitor.proxyId !== null) {
        await requireResource(actor, "proxy:read", "proxy", monitor.proxyId, teamIdLoader);
    }
    if (monitor.remote_browser !== undefined && monitor.remote_browser !== null) {
        await requireResource(actor, "remote_browser:read", "remote_browser", monitor.remote_browser, teamIdLoader);
    }
    if (monitor.parent !== undefined && monitor.parent !== null) {
        await requireResource(actor, "monitor:read", "monitor", monitor.parent, teamIdLoader);
    }
}

/**
 * Handlers for monitor CRUD/control and tags
 * @param {Socket} socket Socket.io instance
 * @param {SuperKumaServer} server SuperKuma server
 * @param {object} helpers Helper functions shared with server.js
 * @param {Function} helpers.startMonitor Start (or resume) a monitor
 * @param {Function} helpers.restartMonitor Restart a monitor
 * @param {Function} helpers.pauseMonitor Pause a monitor
 * @param {Function} helpers.updateMonitorNotification Update notifications for a monitor
 * @returns {void}
 */
module.exports.monitorSocketHandler = (socket, server, helpers) => {
    const { startMonitor, restartMonitor, pauseMonitor, updateMonitorNotification } = helpers;

    // Add a new monitor
    socket.on("add", async (monitor, callback) => {
        try {
            checkLogin(socket);
            await validateMonitorLinkedResources(socket.actor, monitor);
            let bean = R.dispense("monitor");

            let notificationIDList = monitor.notificationIDList;
            delete monitor.notificationIDList;

            // Ensure status code ranges are strings
            if (!monitor.accepted_statuscodes.every((code) => typeof code === "string")) {
                throw new Error("Accepted status codes are not all strings");
            }
            monitor.accepted_statuscodes_json = JSON.stringify(monitor.accepted_statuscodes);
            delete monitor.accepted_statuscodes;

            monitor.kafkaProducerBrokers = JSON.stringify(monitor.kafkaProducerBrokers);
            monitor.kafkaProducerSaslOptions = JSON.stringify(monitor.kafkaProducerSaslOptions);

            monitor.conditions = JSON.stringify(monitor.conditions);

            monitor.rabbitmqNodes = JSON.stringify(monitor.rabbitmqNodes);

            /*
             * List of frontend-only properties that should not be saved to the database.
             * Should clean up before saving to the database.
             */
            const frontendOnlyProperties = [
                "humanReadableInterval",
                "globalpingdnsresolvetypeoptions",
                "responsecheck",
            ];
            for (const prop of frontendOnlyProperties) {
                if (prop in monitor) {
                    delete monitor[prop];
                }
            }

            bean.import(monitor);
            // Map camelCase frontend property to snake_case database column
            if (monitor.retryOnlyOnStatusCodeFailure !== undefined) {
                bean.retry_only_on_status_code_failure = monitor.retryOnlyOnStatusCodeFailure;
            }
            bean.user_id = socket.userID;

            bean.validate();

            await R.store(bean);

            await updateMonitorNotification(bean.id, notificationIDList);

            await server.sendUpdateMonitorIntoList(socket, bean.id);

            if (monitor.active !== false) {
                await startMonitor(socket.userID, bean.id);
            }

            log.info("monitor", `Added Monitor: ${bean.id} User ID: ${socket.userID}`);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                monitorID: bean.id,
            });
        } catch (e) {
            log.error("monitor", `Error adding Monitor: ${monitor.id} User ID: ${socket.userID}`);

            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Edit a monitor
    socket.on("editMonitor", async (monitor, callback) => {
        try {
            let removeGroupChildren = false;
            checkLogin(socket);

            let bean = await R.findOne("monitor", " id = ? ", [monitor.id]);

            if (bean.user_id !== socket.userID) {
                throw new Error("Permission denied.");
            }

            await validateMonitorLinkedResources(socket.actor, monitor);

            // Check if Parent is Descendant (would cause endless loop)
            if (monitor.parent !== null) {
                const childIDs = await Monitor.getAllChildrenIDs(monitor.id);
                if (childIDs.includes(monitor.parent)) {
                    throw new Error("Invalid Monitor Group");
                }
            }

            // Remove children if monitor type has changed (from group to non-group)
            if (bean.type === "group" && monitor.type !== bean.type) {
                removeGroupChildren = true;
            }

            // Ensure status code ranges are strings
            if (!monitor.accepted_statuscodes.every((code) => typeof code === "string")) {
                throw new Error("Accepted status codes are not all strings");
            }

            bean.name = monitor.name;
            bean.description = monitor.description;
            bean.parent = monitor.parent;
            bean.type = monitor.type;
            bean.subtype = monitor.subtype;
            bean.url = monitor.url;
            bean.wsIgnoreSecWebsocketAcceptHeader = monitor.wsIgnoreSecWebsocketAcceptHeader;
            bean.wsSubprotocol = monitor.wsSubprotocol;
            bean.method = monitor.method;
            bean.body = monitor.body;
            bean.ipFamily = monitor.ipFamily;
            bean.headers = monitor.headers;
            bean.basic_auth_user = monitor.basic_auth_user;
            bean.basic_auth_pass = monitor.basic_auth_pass;
            bean.bearer_token = monitor.bearer_token;
            bean.timeout = monitor.timeout;
            bean.oauth_client_id = monitor.oauth_client_id;
            bean.oauth_client_secret = monitor.oauth_client_secret;
            bean.oauth_auth_method = monitor.oauth_auth_method;
            bean.oauth_token_url = monitor.oauth_token_url;
            bean.oauth_scopes = monitor.oauth_scopes;
            bean.oauth_audience = monitor.oauth_audience;
            bean.tlsCa = monitor.tlsCa;
            bean.tlsCert = monitor.tlsCert;
            bean.tlsKey = monitor.tlsKey;
            bean.interval = monitor.interval;
            bean.retryInterval = monitor.retryInterval;
            bean.resendInterval = monitor.resendInterval;
            bean.hostname = monitor.hostname;
            bean.game = monitor.game;
            bean.maxretries = monitor.maxretries;
            bean.port = parseInt(monitor.port);
            bean.location = monitor.location;
            bean.protocol = monitor.protocol;

            if (isNaN(bean.port)) {
                bean.port = null;
            }

            bean.keyword = monitor.keyword;
            bean.invertKeyword = monitor.invertKeyword;
            bean.ignoreTls = monitor.ignoreTls;
            bean.expiryNotification = monitor.expiryNotification;
            bean.domainExpiryNotification = monitor.domainExpiryNotification;
            bean.upsideDown = monitor.upsideDown;
            bean.packetSize = monitor.packetSize;
            bean.maxredirects = monitor.maxredirects;
            bean.accepted_statuscodes_json = JSON.stringify(monitor.accepted_statuscodes);
            bean.save_response = monitor.saveResponse;
            bean.save_error_response = monitor.saveErrorResponse;
            bean.response_max_length = monitor.responseMaxLength;
            bean.dns_resolve_type = monitor.dns_resolve_type;
            bean.dns_resolve_server = monitor.dns_resolve_server;
            bean.pushToken = monitor.pushToken;
            bean.docker_container = monitor.docker_container;
            bean.docker_host = monitor.docker_host;
            bean.proxyId = Number.isInteger(monitor.proxyId) ? monitor.proxyId : null;
            bean.mqttUsername = monitor.mqttUsername;
            bean.mqttPassword = monitor.mqttPassword;
            bean.mqttTopic = monitor.mqttTopic;
            bean.mqttSuccessMessage = monitor.mqttSuccessMessage;
            bean.mqttCheckType = monitor.mqttCheckType;
            bean.mqttWebsocketPath = monitor.mqttWebsocketPath;
            bean.databaseConnectionString = monitor.databaseConnectionString;
            bean.databaseQuery = monitor.databaseQuery;
            bean.authMethod = monitor.authMethod;
            bean.authWorkstation = monitor.authWorkstation;
            bean.authDomain = monitor.authDomain;
            bean.grpcUrl = monitor.grpcUrl;
            bean.grpcProtobuf = monitor.grpcProtobuf;
            bean.grpcServiceName = monitor.grpcServiceName;
            bean.grpcMethod = monitor.grpcMethod;
            bean.grpcBody = monitor.grpcBody;
            bean.grpcMetadata = monitor.grpcMetadata;
            bean.grpcEnableTls = monitor.grpcEnableTls;
            bean.radiusUsername = monitor.radiusUsername;
            bean.radiusPassword = monitor.radiusPassword;
            bean.radiusCalledStationId = monitor.radiusCalledStationId;
            bean.radiusCallingStationId = monitor.radiusCallingStationId;
            bean.radiusSecret = monitor.radiusSecret;
            bean.httpBodyEncoding = monitor.httpBodyEncoding;
            bean.expectedValue = monitor.expectedValue;
            bean.jsonPath = monitor.jsonPath;
            bean.kafkaProducerTopic = monitor.kafkaProducerTopic;
            bean.kafkaProducerBrokers = JSON.stringify(monitor.kafkaProducerBrokers);
            bean.kafkaProducerAllowAutoTopicCreation = monitor.kafkaProducerAllowAutoTopicCreation;
            bean.kafkaProducerSaslOptions = JSON.stringify(monitor.kafkaProducerSaslOptions);
            bean.kafkaProducerMessage = monitor.kafkaProducerMessage;
            bean.cacheBust = monitor.cacheBust;
            bean.kafkaProducerSsl = monitor.kafkaProducerSsl;
            bean.kafkaProducerAllowAutoTopicCreation = monitor.kafkaProducerAllowAutoTopicCreation;
            bean.gamedigGivenPortOnly = monitor.gamedigGivenPortOnly;
            bean.gamedigToken = monitor.gamedigToken;
            bean.remote_browser = monitor.remote_browser;
            bean.smtpSecurity = monitor.smtpSecurity;
            bean.snmpVersion = monitor.snmpVersion;
            bean.snmpOid = monitor.snmpOid;
            bean.jsonPathOperator = monitor.jsonPathOperator;
            bean.retry_only_on_status_code_failure = Boolean(monitor.retryOnlyOnStatusCodeFailure);
            bean.timeout = monitor.timeout;
            bean.rabbitmqNodes = JSON.stringify(monitor.rabbitmqNodes);
            bean.rabbitmqUsername = monitor.rabbitmqUsername;
            bean.rabbitmqPassword = monitor.rabbitmqPassword;
            bean.conditions = JSON.stringify(monitor.conditions);
            bean.manual_status = monitor.manual_status;
            bean.system_service_name = monitor.system_service_name;
            bean.expected_tls_alert = monitor.expectedTlsAlert;

            // ping advanced options
            bean.ping_numeric = monitor.ping_numeric;
            bean.ping_count = monitor.ping_count;
            bean.ping_per_request_timeout = monitor.ping_per_request_timeout;

            bean.validate();

            await R.store(bean);

            if (removeGroupChildren) {
                await Monitor.unlinkAllChildren(monitor.id);
            }

            await updateMonitorNotification(bean.id, monitor.notificationIDList);

            if (await Monitor.isActive(bean.id, bean.active)) {
                await restartMonitor(socket.userID, bean.id);
            }

            await server.sendUpdateMonitorIntoList(socket, bean.id);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                monitorID: bean.id,
            });
        } catch (e) {
            log.error("monitor", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMonitorList", async (callback) => {
        try {
            checkLogin(socket);
            await server.sendMonitorList(socket);
            callback({
                ok: true,
            });
        } catch (e) {
            log.error("monitor", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMonitor", async (monitorID, callback) => {
        try {
            checkLogin(socket);
            await requireResource(socket.actor, "monitor:read", "monitor", monitorID, teamIdLoader);

            log.info("monitor", `Get Monitor: ${monitorID} User ID: ${socket.userID}`);

            let monitor = await R.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, socket.userID]);
            const monitorData = [{ id: monitor.id, active: monitor.active }];
            const preloadData = await Monitor.preparePreloadData(monitorData);
            callback({
                ok: true,
                monitor: monitor.toJSON(preloadData),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // partial { type, url, hostname, grpcUrl }
    socket.on("checkDomain", async (partial, callback) => {
        try {
            checkLogin(socket);
            const DomainExpiry = require("../model/domain_expiry");
            const supportInfo = await DomainExpiry.checkSupport(partial);
            callback({
                ok: true,
                domain: supportInfo.domain,
                tld: supportInfo.tld,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
                msgi18n: !!e.msgi18n,
                meta: e.meta ?? {},
            });
        }
    });

    socket.on("getMonitorBeats", async (monitorID, period, callback) => {
        try {
            checkLogin(socket);
            await requireResource(socket.actor, "monitor:read", "monitor", monitorID, teamIdLoader);

            log.info("monitor", `Get Monitor Beats: ${monitorID} User ID: ${socket.userID}`);

            if (period == null) {
                throw new Error("Invalid period.");
            }

            const sqlHourOffset = Database.sqlHourOffset();

            let list = await R.getAll(
                `
                SELECT *
                FROM heartbeat
                WHERE monitor_id = ?
                  AND time > ${sqlHourOffset}
                ORDER BY time ASC
            `,
                [monitorID, -period]
            );

            callback({
                ok: true,
                data: list,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Start or Resume the monitor
    socket.on("resumeMonitor", async (monitorID, callback) => {
        try {
            checkLogin(socket);
            await startMonitor(socket.userID, monitorID);
            await server.sendUpdateMonitorIntoList(socket, monitorID);

            callback({
                ok: true,
                msg: "successResumed",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("pauseMonitor", async (monitorID, callback) => {
        try {
            checkLogin(socket);
            await pauseMonitor(socket.userID, monitorID);
            await server.sendUpdateMonitorIntoList(socket, monitorID);

            callback({
                ok: true,
                msg: "successPaused",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteMonitor", async (monitorID, deleteChildren, callback) => {
        try {
            // Backward compatibility: if deleteChildren is omitted, the second parameter is the callback
            if (typeof deleteChildren === "function") {
                callback = deleteChildren;
                deleteChildren = false;
            }

            checkLogin(socket);
            await requireResource(socket.actor, "monitor:delete", "monitor", monitorID, teamIdLoader);

            const startTime = Date.now();

            // Check if this is a group monitor
            const monitor = await R.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, socket.userID]);

            // Log with context about deletion type
            if (monitor && monitor.type === "group") {
                if (deleteChildren) {
                    log.info("manage", `Delete Group and Children: ${monitorID} User ID: ${socket.userID}`);
                } else {
                    log.info("manage", `Delete Group (unlink children): ${monitorID} User ID: ${socket.userID}`);
                }
            } else {
                log.info("manage", `Delete Monitor: ${monitorID} User ID: ${socket.userID}`);
            }

            if (monitor && monitor.type === "group") {
                // Get all children before processing
                const children = await Monitor.getChildren(monitorID);

                if (deleteChildren) {
                    // Delete all child monitors recursively
                    if (children && children.length > 0) {
                        for (const child of children) {
                            await Monitor.deleteMonitorRecursively(child.id, socket.userID);
                            await server.sendDeleteMonitorFromList(socket, child.id);
                        }
                    }
                } else {
                    // Unlink all children from the group (set parent to null)
                    await Monitor.unlinkAllChildren(monitorID);

                    // Notify frontend to update each child monitor's parent to null
                    if (children && children.length > 0) {
                        for (const child of children) {
                            await server.sendUpdateMonitorIntoList(socket, child.id);
                        }
                    }
                }
            }

            // Delete the monitor itself
            await Monitor.deleteMonitor(monitorID, socket.userID);

            // Fix #2880
            apicache.clear();

            const endTime = Date.now();

            // Log completion with context about children handling
            if (monitor && monitor.type === "group") {
                if (deleteChildren) {
                    log.info(
                        "DB",
                        `Delete Monitor completed (group and children deleted) in: ${endTime - startTime} ms`
                    );
                } else {
                    log.info(
                        "DB",
                        `Delete Monitor completed (group deleted, children unlinked) in: ${endTime - startTime} ms`
                    );
                }
            } else {
                log.info("DB", `Delete Monitor completed in: ${endTime - startTime} ms`);
            }

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });
            await server.sendDeleteMonitorFromList(socket, monitorID);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getTags", async (callback) => {
        try {
            checkLogin(socket);

            const list = await R.findAll("tag");

            callback({
                ok: true,
                tags: list.map((bean) => bean.toJSON()),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("addTag", async (tag, callback) => {
        try {
            checkLogin(socket);

            let bean = R.dispense("tag");
            bean.name = tag.name;
            bean.color = tag.color;
            await R.store(bean);

            callback({
                ok: true,
                tag: await bean.toJSON(),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("editTag", async (tag, callback) => {
        try {
            checkLogin(socket);
            await requireResource(socket.actor, "tag:manage", "tag", tag.id, teamIdLoader);

            let bean = await R.findOne("tag", " id = ? ", [tag.id]);
            if (bean == null) {
                callback({
                    ok: false,
                    msg: "tagNotFound",
                    msgi18n: true,
                });
                return;
            }
            bean.name = tag.name;
            bean.color = tag.color;
            await R.store(bean);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                tag: await bean.toJSON(),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteTag", async (tagID, callback) => {
        try {
            checkLogin(socket);
            await requireResource(socket.actor, "tag:manage", "tag", tagID, teamIdLoader);

            await R.exec("DELETE FROM tag WHERE id = ? ", [tagID]);

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

    socket.on("addMonitorTag", async (tagID, monitorID, value, callback) => {
        try {
            checkLogin(socket);
            await requireResource(socket.actor, "monitor:update", "monitor", monitorID, teamIdLoader);
            tagID = validate(monitorTagIDSchema, tagID);
            monitorID = validate(monitorTagIDSchema, monitorID);
            value = validate(monitorTagValueSchema, value);

            await R.exec("INSERT INTO monitor_tag (tag_id, monitor_id, value) VALUES (?, ?, ?)", [
                tagID,
                monitorID,
                value,
            ]);

            await server.sendUpdateMonitorIntoList(socket, monitorID);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("editMonitorTag", async (tagID, monitorID, value, callback) => {
        try {
            checkLogin(socket);
            await requireResource(socket.actor, "monitor:update", "monitor", monitorID, teamIdLoader);
            tagID = validate(monitorTagIDSchema, tagID);
            monitorID = validate(monitorTagIDSchema, monitorID);
            value = validate(monitorTagValueSchema, value);

            await R.exec("UPDATE monitor_tag SET value = ? WHERE tag_id = ? AND monitor_id = ?", [
                value,
                tagID,
                monitorID,
            ]);

            await server.sendUpdateMonitorIntoList(socket, monitorID);

            callback({
                ok: true,
                msg: "successEdited",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteMonitorTag", async (tagID, monitorID, value, callback) => {
        try {
            checkLogin(socket);
            await requireResource(socket.actor, "monitor:update", "monitor", monitorID, teamIdLoader);
            tagID = validate(monitorTagIDSchema, tagID);
            monitorID = validate(monitorTagIDSchema, monitorID);
            value = validate(monitorTagValueSchema, value);

            await R.exec("DELETE FROM monitor_tag WHERE tag_id = ? AND monitor_id = ? AND value = ?", [
                tagID,
                monitorID,
                value,
            ]);

            await server.sendUpdateMonitorIntoList(socket, monitorID);

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

    socket.on("monitorImportantHeartbeatListCount", async (monitorID, callback) => {
        try {
            checkLogin(socket);

            let count;
            if (monitorID == null) {
                count = await R.count("heartbeat", "important = 1");
            } else {
                count = await R.count("heartbeat", "monitor_id = ? AND important = 1", [monitorID]);
            }

            callback({
                ok: true,
                count: count,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("monitorImportantHeartbeatListPaged", async (monitorID, offset, count, callback) => {
        try {
            checkLogin(socket);

            let list;
            if (monitorID == null) {
                list = await R.find(
                    "heartbeat",
                    `
                    important = 1
                    ORDER BY time DESC
                    LIMIT ?
                    OFFSET ?
                `,
                    [count, offset]
                );
            } else {
                list = await R.find(
                    "heartbeat",
                    `
                    monitor_id = ?
                    AND important = 1
                    ORDER BY time DESC
                    LIMIT ?
                    OFFSET ?
                `,
                    [monitorID, count, offset]
                );
            }

            callback({
                ok: true,
                data: list,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
