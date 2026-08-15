process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const Monitor = require("../../server/model/monitor");
const { Settings } = require("../../server/settings");

/**
 * Creates and stores a Monitor bean with the given field overrides. Mirrors
 * the createMonitor() idiom in test-monitor-send-notification.js.
 * @param {object} fields Monitor fields to assign (camelCase, matching bean property names)
 * @returns {Promise<Monitor>} The stored monitor bean, reloaded from the DB
 */
async function createMonitor(fields) {
    let bean = R.dispense("monitor");
    bean.import({
        name: "maintenance-tag test monitor",
        type: "http",
        url: "https://example.com",
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
    return await R.load("monitor", bean.id);
}

/**
 * Dispense + store an always-on ("manual" strategy) maintenance bean. Mirrors
 * putUnderMaintenance()'s bean setup in test-api-push-endpoint.js, but without
 * registering it on SuperKumaServer's in-memory maintenanceList --
 * Monitor.isUnderMaintenance() reads that list via
 * SuperKumaServer#getMaintenance(), so tests register it themselves via
 * registerLiveMaintenance() once they have the id they need.
 * @param {string} title Maintenance title, for readable test fixtures.
 * @returns {Promise<object>} The stored, freshly-loaded maintenance bean.
 */
async function createManualMaintenance(title) {
    const bean = R.dispense("maintenance");
    bean.title = title;
    bean.description = "";
    bean.active = true;
    bean.strategy = "manual";
    await R.store(bean);
    return bean;
}

/**
 * Register a maintenance bean on the live SuperKumaServer singleton's
 * in-memory maintenanceList, the second half (besides DB rows) that
 * Monitor.isUnderMaintenance() actually reads in production.
 * @param {object} bean The maintenance bean to register.
 * @returns {void}
 */
function registerLiveMaintenance(bean) {
    const { SuperKumaServer } = require("../../server/superkuma-server");
    SuperKumaServer.getInstance().maintenanceList[bean.id] = bean;
}

/**
 * Create and store a tag bean.
 * @param {string} name Tag name.
 * @returns {Promise<number>} The stored tag's id.
 */
async function createTag(name) {
    await R.knex("tag").insert({ name, color: "#000000" });
    return (await R.knex("tag").where("name", name).first()).id;
}

describe("Monitor.isUnderMaintenance() — tag-based maintenance windows", () => {
    const testDb = new TestDB("./data/test-monitor-maintenance-tag");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("a monitor carrying a maintenance's tag is under maintenance", async () => {
        const monitor = await createMonitor({ name: "tagged-firewall" });
        const maintenance = await createManualMaintenance("firewall quiet window");
        registerLiveMaintenance(maintenance);
        const tagId = await createTag("firewall-tag-1");

        await R.knex("maintenance_tag").insert({ maintenance_id: maintenance.id, tag_id: tagId });
        await R.knex("monitor_tag").insert({ monitor_id: monitor.id, tag_id: tagId });

        assert.strictEqual(await Monitor.isUnderMaintenance(monitor.id), true);
    });

    test("a monitor NOT carrying the tag is not under maintenance", async () => {
        const monitor = await createMonitor({ name: "untagged-firewall" });
        const maintenance = await createManualMaintenance("another quiet window");
        registerLiveMaintenance(maintenance);
        const tagId = await createTag("firewall-tag-2");

        await R.knex("maintenance_tag").insert({ maintenance_id: maintenance.id, tag_id: tagId });
        // Deliberately not tagging the monitor.

        assert.strictEqual(await Monitor.isUnderMaintenance(monitor.id), false);
    });

    test("a monitor tagged AFTER the maintenance window was created is covered automatically (live resolution)", async () => {
        const monitor = await createMonitor({ name: "later-tagged-firewall" });
        const maintenance = await createManualMaintenance("preexisting window");
        registerLiveMaintenance(maintenance);
        const tagId = await createTag("firewall-tag-3");
        await R.knex("maintenance_tag").insert({ maintenance_id: maintenance.id, tag_id: tagId });

        assert.strictEqual(await Monitor.isUnderMaintenance(monitor.id), false, "not tagged yet");

        await R.knex("monitor_tag").insert({ monitor_id: monitor.id, tag_id: tagId });

        assert.strictEqual(await Monitor.isUnderMaintenance(monitor.id), true, "covered as soon as tagged");
    });

    test("removing the tag from a monitor drops it out of the maintenance window (live resolution, not a snapshot)", async () => {
        const monitor = await createMonitor({ name: "detagged-firewall" });
        const maintenance = await createManualMaintenance("window that gets outgrown");
        registerLiveMaintenance(maintenance);
        const tagId = await createTag("firewall-tag-4");
        await R.knex("maintenance_tag").insert({ maintenance_id: maintenance.id, tag_id: tagId });
        await R.knex("monitor_tag").insert({ monitor_id: monitor.id, tag_id: tagId });

        assert.strictEqual(await Monitor.isUnderMaintenance(monitor.id), true);

        await R.knex("monitor_tag").where({ monitor_id: monitor.id, tag_id: tagId }).delete();

        assert.strictEqual(await Monitor.isUnderMaintenance(monitor.id), false);
    });

    test("direct monitor_maintenance links still work alongside tag-based ones (no regression)", async () => {
        const monitor = await createMonitor({ name: "directly-linked-firewall" });
        const maintenance = await createManualMaintenance("direct link window");
        registerLiveMaintenance(maintenance);

        await R.knex("monitor_maintenance").insert({ monitor_id: monitor.id, maintenance_id: maintenance.id });

        assert.strictEqual(await Monitor.isUnderMaintenance(monitor.id), true);
    });
});
