process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const Monitor = require("../../server/model/monitor");
const { Settings } = require("../../server/settings");
const { UP, DOWN, PENDING, MAINTENANCE } = require("../../src/util");

const testDb = new TestDB("./data/test-monitor-model");

/**
 * Creates and stores a Monitor bean with the given field overrides.
 * Mirrors the bean construction idiom used by
 * server/socket-handlers/monitor-socket-handler.js ("add" handler).
 * @param {object} fields Monitor fields to assign (camelCase, matching bean property names)
 * @returns {Promise<Monitor>} The stored monitor bean
 */
async function createMonitor(fields) {
    let bean = R.dispense("monitor");
    bean.import({
        name: "test monitor",
        interval: 20,
        maxretries: 0,
        accepted_statuscodes_json: JSON.stringify(["200-299"]),
        conditions: "[]",
        kafkaProducerBrokers: "[]",
        kafkaProducerSaslOptions: "{}",
        rabbitmqNodes: "[]",
        ...fields,
    });
    await R.store(bean);
    // Reload from the DB so column defaults (e.g. active/ignore_tls/upside_down) that
    // SQLite applies at insert time are reflected on the in-memory bean, matching how
    // production code always operates on freshly-loaded beans rather than the
    // just-dispensed instance.
    return await R.load("monitor", bean.id);
}

describe("Monitor model - characterization", () => {
    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    describe("toJSON()", () => {
        test("http monitor: includeSensitiveData=true exposes secrets in plaintext (current behavior, see ADR-0007)", async () => {
            const monitor = await createMonitor({
                type: "http",
                name: "http monitor",
                url: "https://example.com",
                method: "GET",
                basic_auth_user: "alice",
                basic_auth_pass: "s3cret-pass",
                bearer_token: "tok_abc123",
                oauth_client_id: "client-id",
                oauth_client_secret: "oauth-secret",
                oauth_auth_method: "client_secret_basic",
                oauth_token_url: "https://example.com/oauth/token",
            });

            const preloadData = await Monitor.preparePreloadData([monitor]);
            const json = monitor.toJSON(preloadData, true);

            assert.strictEqual(json.includeSensitiveData, true);
            assert.strictEqual(json.basic_auth_user, "alice");
            assert.strictEqual(json.basic_auth_pass, "s3cret-pass");
            assert.strictEqual(json.bearer_token, "tok_abc123");
            assert.strictEqual(json.oauth_client_id, "client-id");
            assert.strictEqual(json.oauth_client_secret, "oauth-secret");
            assert.strictEqual(json.oauth_auth_method, "client_secret_basic");
            assert.strictEqual(json.oauth_token_url, "https://example.com/oauth/token");

            // Non-sensitive fields still present alongside sensitive ones.
            assert.strictEqual(json.id, monitor.id);
            assert.strictEqual(json.type, "http");
            assert.strictEqual(json.url, "https://example.com");
            assert.deepStrictEqual(json.accepted_statuscodes, ["200-299"]);
        });

        test("http monitor: includeSensitiveData=false CURRENTLY OMITS the sensitive block entirely (no masking, keys absent)", async () => {
            const monitor = await createMonitor({
                type: "http",
                name: "http monitor no sensitive",
                url: "https://example.com",
                basic_auth_user: "alice",
                basic_auth_pass: "s3cret-pass",
                bearer_token: "tok_abc123",
                oauth_client_secret: "oauth-secret",
                oauth_auth_method: "client_secret_basic",
            });

            const preloadData = await Monitor.preparePreloadData([monitor]);
            const json = monitor.toJSON(preloadData, false);

            assert.strictEqual(json.includeSensitiveData, false);

            // Documents current reality: keys are simply not present (not masked/redacted).
            assert.strictEqual("basic_auth_user" in json, false);
            assert.strictEqual("basic_auth_pass" in json, false);
            assert.strictEqual("bearer_token" in json, false);
            assert.strictEqual("oauth_client_secret" in json, false);
            assert.strictEqual("oauth_auth_method" in json, false);
            assert.strictEqual("headers" in json, false);
            assert.strictEqual("body" in json, false);

            // Non-sensitive data is unaffected.
            assert.strictEqual(json.type, "http");
            assert.strictEqual(json.url, "https://example.com");
        });

        test("tcp/port monitor: sensitive fields default to null/undefined and are still exposed as-is when includeSensitiveData=true", async () => {
            const monitor = await createMonitor({
                type: "port",
                name: "tcp monitor",
                hostname: "localhost",
                port: 5432,
            });

            const preloadData = await Monitor.preparePreloadData([monitor]);
            const json = monitor.toJSON(preloadData, true);

            assert.strictEqual(json.type, "port");
            assert.strictEqual(json.hostname, "localhost");
            assert.strictEqual(json.port, 5432);
            // No basic auth/bearer token set on this monitor type - current behavior is to
            // still include the keys (not to omit them) with `null`, since these columns
            // have no DB default and the fixture reloads the bean from the DB.
            assert.strictEqual("basic_auth_user" in json, true);
            assert.strictEqual(json.basic_auth_user, null);
            assert.strictEqual("basic_auth_pass" in json, true);
            assert.strictEqual(json.basic_auth_pass, null);
            assert.strictEqual("bearer_token" in json, true);
            assert.strictEqual(json.bearer_token, null);
        });

        test("dns monitor: exposes dns_resolve_type/server/last_result and radius/mqtt secrets present-but-null", async () => {
            const monitor = await createMonitor({
                type: "dns",
                name: "dns monitor",
                hostname: "example.com",
                dns_resolve_type: "A",
                dns_resolve_server: "1.1.1.1",
                dns_last_result: "93.184.216.34",
            });

            const preloadData = await Monitor.preparePreloadData([monitor]);
            const json = monitor.toJSON(preloadData, true);

            assert.strictEqual(json.type, "dns");
            assert.strictEqual(json.dns_resolve_type, "A");
            assert.strictEqual(json.dns_resolve_server, "1.1.1.1");
            assert.strictEqual(json.dns_last_result, "93.184.216.34");

            // radius/mqtt secret fields are part of the sensitive block regardless of monitor type.
            assert.strictEqual("radiusPassword" in json, true);
            assert.strictEqual("radiusSecret" in json, true);
            assert.strictEqual("mqttPassword" in json, true);
        });

        test("push monitor: exposes pushToken in plaintext when includeSensitiveData=true, omitted when false", async () => {
            const monitor = await createMonitor({
                type: "push",
                name: "push monitor",
                push_token: "push-tok-xyz",
            });

            const preloadData = await Monitor.preparePreloadData([monitor]);

            const jsonWithSensitive = monitor.toJSON(preloadData, true);
            assert.strictEqual(jsonWithSensitive.type, "push");
            assert.strictEqual(jsonWithSensitive.pushToken, "push-tok-xyz");

            const jsonWithoutSensitive = monitor.toJSON(preloadData, false);
            assert.strictEqual("pushToken" in jsonWithoutSensitive, false);
        });

        test("radius monitor: radius_password / radius_secret exposed in plaintext when includeSensitiveData=true", async () => {
            const monitor = await createMonitor({
                type: "radius",
                name: "radius monitor",
                hostname: "radius.example.com",
                port: 1812,
                radius_username: "raduser",
                radius_password: "rad-user-pass",
                radius_secret: "rad-shared-secret",
                radius_calling_station_id: "00-00-00-00-00-00",
                radius_called_station_id: "11-11-11-11-11-11",
            });

            const preloadData = await Monitor.preparePreloadData([monitor]);
            const json = monitor.toJSON(preloadData, true);

            assert.strictEqual(json.radiusUsername, "raduser");
            assert.strictEqual(json.radiusPassword, "rad-user-pass");
            assert.strictEqual(json.radiusSecret, "rad-shared-secret");
            assert.strictEqual(json.radiusCallingStationId, "00-00-00-00-00-00");
            assert.strictEqual(json.radiusCalledStationId, "11-11-11-11-11-11");

            const jsonNoSensitive = monitor.toJSON(preloadData, false);
            assert.strictEqual("radiusPassword" in jsonNoSensitive, false);
            assert.strictEqual("radiusSecret" in jsonNoSensitive, false);
            // Non-sensitive radius fields remain present without the sensitive flag.
            assert.strictEqual(jsonNoSensitive.radiusCallingStationId, "00-00-00-00-00-00");
            assert.strictEqual(jsonNoSensitive.radiusCalledStationId, "11-11-11-11-11-11");
        });

        test("mqtt monitor: mqttPassword and mqttUsername exposed in plaintext when includeSensitiveData=true", async () => {
            const monitor = await createMonitor({
                type: "mqtt",
                name: "mqtt monitor",
                hostname: "mqtt.example.com",
                port: 1883,
                mqttUsername: "mqttuser",
                mqttPassword: "mqtt-pass",
                mqttTopic: "topic/test",
                mqttSuccessMessage: "ok",
                mqttCheckType: "keyword",
            });

            const preloadData = await Monitor.preparePreloadData([monitor]);
            const json = monitor.toJSON(preloadData, true);

            assert.strictEqual(json.mqttUsername, "mqttuser");
            assert.strictEqual(json.mqttPassword, "mqtt-pass");
            assert.strictEqual(json.mqttTopic, "topic/test");
            assert.strictEqual(json.mqttSuccessMessage, "ok");
            assert.strictEqual(json.mqttCheckType, "keyword");

            const jsonNoSensitive = monitor.toJSON(preloadData, false);
            assert.strictEqual("mqttPassword" in jsonNoSensitive, false);
            assert.strictEqual("mqttUsername" in jsonNoSensitive, false);
            // Non-sensitive mqtt fields are outside the sensitive block.
            assert.strictEqual(jsonNoSensitive.mqttTopic, "topic/test");
        });

        test("sql-style monitor: databaseConnectionString is exposed in plaintext when includeSensitiveData=true, omitted when false", async () => {
            const monitor = await createMonitor({
                type: "postgres",
                name: "postgres monitor",
                databaseConnectionString: "postgres://user:pass@localhost:5432/db",
                databaseQuery: "SELECT 1",
            });

            const preloadData = await Monitor.preparePreloadData([monitor]);

            const jsonWithSensitive = monitor.toJSON(preloadData, true);
            assert.strictEqual(jsonWithSensitive.databaseConnectionString, "postgres://user:pass@localhost:5432/db");
            // databaseQuery is NOT gated by includeSensitiveData - always present.
            assert.strictEqual(jsonWithSensitive.databaseQuery, "SELECT 1");

            const jsonWithoutSensitive = monitor.toJSON(preloadData, false);
            assert.strictEqual("databaseConnectionString" in jsonWithoutSensitive, false);
            // databaseQuery remains present even without sensitive data - current behavior,
            // documents that the query string itself is not treated as sensitive.
            assert.strictEqual(jsonWithoutSensitive.databaseQuery, "SELECT 1");
        });

        test("getAcceptedStatuscodes() returns the parsed accepted_statuscodes_json array", async () => {
            const monitor = await createMonitor({
                type: "http",
                name: "statuscode monitor",
                url: "https://example.com",
                accepted_statuscodes_json: JSON.stringify(["200-299", "301", "302"]),
            });

            assert.deepStrictEqual(monitor.getAcceptedStatuscodes(), ["200-299", "301", "302"]);

            const preloadData = await Monitor.preparePreloadData([monitor]);
            const json = monitor.toJSON(preloadData, true);
            assert.deepStrictEqual(json.accepted_statuscodes, ["200-299", "301", "302"]);
        });

        test("boolean-coercing helpers return real booleans for truthy/falsy DB values", async () => {
            const monitor = await createMonitor({
                type: "http",
                name: "boolean helpers monitor",
                url: "https://example.com",
                upside_down: 1,
                ignore_tls: 0,
            });

            assert.strictEqual(monitor.isUpsideDown(), true);
            assert.strictEqual(monitor.getIgnoreTls(), false);

            const preloadData = await Monitor.preparePreloadData([monitor]);
            const json = monitor.toJSON(preloadData, true);
            assert.strictEqual(json.upsideDown, true);
            assert.strictEqual(json.ignoreTls, false);
        });

        test("remoteInstanceId: exposes the raw remote_instance_id column value, or null when unset (F3 federation slice, see ADR-0008)", async () => {
            const localMonitor = await createMonitor({
                type: "http",
                name: "local monitor",
                url: "https://example.com",
            });

            const preloadDataLocal = await Monitor.preparePreloadData([localMonitor]);
            const jsonLocal = localMonitor.toJSON(preloadDataLocal, true);

            // NULL remote_instance_id -> exposed as null, not omitted and not undefined.
            assert.strictEqual("remoteInstanceId" in jsonLocal, true);
            assert.strictEqual(jsonLocal.remoteInstanceId, null);
            assert.notStrictEqual(jsonLocal.remoteInstanceId, undefined);

            const remoteInstance = R.dispense("remote_instance");
            remoteInstance.import({
                instance_id: "agent-1",
                name: "Agent One",
                token_hash: "hash",
                active: true,
            });
            await R.store(remoteInstance);

            const federatedMonitor = await createMonitor({
                type: "push",
                name: "federated monitor",
                remote_instance_id: remoteInstance.id,
            });

            const preloadDataFederated = await Monitor.preparePreloadData([federatedMonitor]);
            const jsonFederated = federatedMonitor.toJSON(preloadDataFederated, true);

            // Raw passthrough of the FK column value - no join/resolve of the remote
            // instance's name (that lookup happens client-side); the monitor's own
            // "name" field is unaffected by federation.
            assert.strictEqual(jsonFederated.remoteInstanceId, remoteInstance.id);
            assert.strictEqual(jsonFederated.name, "federated monitor");
        });

        test("preloadData-derived fields (path, childrenIDs, active, tags, notificationIDList, maintenance) reflect real DB lookups", async () => {
            const monitor = await createMonitor({
                type: "http",
                name: "preload monitor",
                url: "https://example.com",
            });

            const preloadData = await Monitor.preparePreloadData([monitor]);
            const json = monitor.toJSON(preloadData, true);

            // "path" is the chain of ancestor monitor NAMES (not IDs) up to and including
            // this monitor - a root monitor's path is just its own name.
            assert.deepStrictEqual(json.path, ["preload monitor"]);
            assert.strictEqual(json.pathName, "preload monitor");
            assert.deepStrictEqual(json.childrenIDs, []);
            assert.strictEqual(json.active, true);
            assert.strictEqual(json.forceInactive, false);
            assert.deepStrictEqual(json.notificationIDList, {});
            assert.deepStrictEqual(json.tags, []);
            assert.strictEqual(json.maintenance, false);
        });
    });

    describe("toPublicJSON()", () => {
        // sendUrl/customUrl are NOT columns on the `monitor` table - they live on the
        // monitor_group join table and are attached as plain in-memory properties onto
        // the Monitor instance by the caller (see server/socket-handlers/status-page-socket-handler.js).
        // We replicate that here rather than persisting them through the bean.

        test("default (no tags, no cert expiry): exact key set is {id, name, sendUrl, type}", async () => {
            const monitor = await createMonitor({
                type: "http",
                name: "public monitor",
                url: "https://example.com",
            });
            monitor.sendUrl = false;

            const json = await monitor.toPublicJSON();
            const keys = Object.keys(json).sort();

            assert.deepStrictEqual(keys, ["id", "name", "sendUrl", "type"]);
            assert.strictEqual(json.id, monitor.id);
            assert.strictEqual(json.name, "public monitor");
            assert.strictEqual(json.type, "http");
            // sendUrl falsy -> no "url" key at all (obj.url only added when this.sendUrl truthy).
            assert.strictEqual("url" in json, false);
        });

        test("sendUrl=true adds the 'url' key, preferring customUrl over url", async () => {
            const monitor = await createMonitor({
                type: "http",
                name: "public monitor with url",
                url: "https://example.com",
            });
            monitor.sendUrl = true;
            monitor.customUrl = "https://custom.example.com";

            const json = await monitor.toPublicJSON();
            const keys = Object.keys(json).sort();

            assert.deepStrictEqual(keys, ["id", "name", "sendUrl", "type", "url"]);
            assert.strictEqual(json.url, "https://custom.example.com");
        });

        test("showTags=true adds exactly the 'tags' key (empty array when monitor has no tags)", async () => {
            const monitor = await createMonitor({
                type: "http",
                name: "public monitor with tags flag",
                url: "https://example.com",
            });

            const json = await monitor.toPublicJSON(true, false);
            const keys = Object.keys(json).sort();

            assert.deepStrictEqual(keys, ["id", "name", "sendUrl", "tags", "type"]);
            assert.deepStrictEqual(json.tags, []);
        });

        test("certExpiry=true adds exactly certExpiryDaysRemaining/validCert (empty/false with no TLS info stored)", async () => {
            const monitor = await createMonitor({
                type: "http",
                name: "public monitor with cert flag",
                url: "https://example.com",
            });

            const json = await monitor.toPublicJSON(false, true);
            const keys = Object.keys(json).sort();

            assert.deepStrictEqual(keys, ["certExpiryDaysRemaining", "id", "name", "sendUrl", "type", "validCert"]);
            assert.strictEqual(json.certExpiryDaysRemaining, "");
            assert.strictEqual(json.validCert, false);
        });

        test("showTags=true and certExpiry=true together produce the full combined key set", async () => {
            const monitor = await createMonitor({
                type: "http",
                name: "public monitor full",
                url: "https://example.com",
            });
            monitor.sendUrl = true;

            const json = await monitor.toPublicJSON(true, true);
            const keys = Object.keys(json).sort();

            assert.deepStrictEqual(keys, [
                "certExpiryDaysRemaining",
                "id",
                "name",
                "sendUrl",
                "tags",
                "type",
                "url",
                "validCert",
            ]);
        });
    });

    describe("small pure/near-pure helpers", () => {
        test("isUpsideDown() coerces DB truthy/falsy values to real booleans", () => {
            const monitor = Object.create(Monitor.prototype);
            monitor.upsideDown = 1;
            assert.strictEqual(monitor.isUpsideDown(), true);

            monitor.upsideDown = 0;
            assert.strictEqual(monitor.isUpsideDown(), false);

            monitor.upsideDown = null;
            assert.strictEqual(monitor.isUpsideDown(), false);
        });

        test("getAcceptedStatuscodes() parses JSON without validation (throws on malformed JSON)", () => {
            const monitor = Object.create(Monitor.prototype);
            monitor.accepted_statuscodes_json = '["200-299"]';
            assert.deepStrictEqual(monitor.getAcceptedStatuscodes(), ["200-299"]);

            monitor.accepted_statuscodes_json = "not json";
            assert.throws(() => monitor.getAcceptedStatuscodes(), SyntaxError);
        });

        test("static isImportantForNotification() truth table (current transition rules)", () => {
            // Any status on the very first beat is important.
            assert.strictEqual(Monitor.isImportantForNotification(true, null, UP), true);
            assert.strictEqual(Monitor.isImportantForNotification(true, null, DOWN), true);

            // UP -> DOWN and DOWN -> UP are important.
            assert.strictEqual(Monitor.isImportantForNotification(false, UP, DOWN), true);
            assert.strictEqual(Monitor.isImportantForNotification(false, DOWN, UP), true);

            // PENDING -> DOWN and MAINTENANCE -> DOWN are important.
            assert.strictEqual(Monitor.isImportantForNotification(false, PENDING, DOWN), true);
            assert.strictEqual(Monitor.isImportantForNotification(false, MAINTENANCE, DOWN), true);

            // Same-status transitions are not important.
            assert.strictEqual(Monitor.isImportantForNotification(false, UP, UP), false);
            assert.strictEqual(Monitor.isImportantForNotification(false, DOWN, DOWN), false);
            assert.strictEqual(Monitor.isImportantForNotification(false, PENDING, PENDING), false);
            assert.strictEqual(Monitor.isImportantForNotification(false, MAINTENANCE, MAINTENANCE), false);

            // UP -> PENDING and PENDING -> UP are not important.
            assert.strictEqual(Monitor.isImportantForNotification(false, UP, PENDING), false);
            assert.strictEqual(Monitor.isImportantForNotification(false, PENDING, UP), false);

            // DOWN -> MAINTENANCE and UP -> MAINTENANCE are not important.
            assert.strictEqual(Monitor.isImportantForNotification(false, DOWN, MAINTENANCE), false);
            assert.strictEqual(Monitor.isImportantForNotification(false, UP, MAINTENANCE), false);
        });
    });
});
