process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");

// server.js normally registers these dayjs plugins once at boot; api-router.js
// (required standalone here, without booting the full server.js) needs them
// for its heartbeat/status formatting paths.
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

const { Settings } = require("../../server/settings");
const { UP } = require("../../src/util");

const testDb = new TestDB("./data/test-badge-authz");

/**
 * Send a GET request to a listening local server and resolve with the raw
 * text body and status code.
 * @param {number} port Port the test server is listening on
 * @param {string} path Request path
 * @returns {Promise<{status: number, body: string}>} Parsed response
 */
function getText(port, path) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: "127.0.0.1", port, path }, (response) => {
            let raw = "";
            response.on("data", (chunk) => (raw += chunk));
            response.on("end", () => resolve({ status: response.statusCode, body: raw }));
        }).on("error", reject);
    });
}

/**
 * Create a monitor row owned by the given team.
 * @param {number} teamId Owning team id.
 * @param {string} name Monitor name.
 * @returns {Promise<number>} The created monitor's id.
 */
async function createMonitor(teamId, name) {
    const bean = R.dispense("monitor");
    bean.name = name;
    bean.type = "http";
    bean.url = "https://example.com";
    bean.interval = 60;
    bean.team_id = teamId;
    const id = await R.store(bean);

    // A previous heartbeat so the badge has a real, non-"N/A" status to
    // distinguish "denied" (isMonitorPublic=false) from "genuinely no data".
    const hb = R.dispense("heartbeat");
    hb.monitor_id = id;
    hb.status = UP;
    hb.time = R.isoDateTime();
    hb.important = true;
    await R.store(hb);

    return id;
}

/**
 * Create a status_page row owned by the given team.
 * @param {number} teamId Owning team id.
 * @param {string} slug Unique slug.
 * @returns {Promise<number>} The created status page's id.
 */
async function createStatusPage(teamId, slug) {
    const bean = R.dispense("status_page");
    bean.slug = slug;
    bean.title = `Title for ${slug}`;
    bean.theme = "auto";
    bean.icon = "";
    bean.autoRefreshInterval = 300;
    bean.team_id = teamId;
    return R.store(bean);
}

/**
 * Create a group belonging to a status page, and link a monitor to it.
 * @param {number} statusPageId Owning status page id.
 * @param {number} monitorId Monitor to link into the group.
 * @param {boolean} isPublic Whether the group is public.
 * @returns {Promise<number>} The created group's id.
 */
async function createPublicGroupWithMonitor(statusPageId, monitorId, isPublic) {
    const groupBean = R.dispense("group");
    groupBean.name = "Services";
    groupBean.public = isPublic;
    groupBean.active = true;
    groupBean.weight = 1;
    groupBean.status_page_id = statusPageId;
    const groupId = await R.store(groupBean);

    const linkBean = R.dispense("monitor_group");
    linkBean.monitor_id = monitorId;
    linkBean.group_id = groupId;
    linkBean.weight = 1;
    linkBean.send_url = false;
    await R.store(linkBean);

    return groupId;
}

describe("isMonitorPublic badge-leak fix (ADR-0010 R8)", () => {
    let httpServer;
    let port;

    before(async () => {
        await testDb.create();

        const app = express();
        const apiRouter = require("../../server/routers/api-router");
        app.use(apiRouter);

        httpServer = http.createServer(app);
        await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
        port = httpServer.address().port;
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await new Promise((resolve) => httpServer.close(resolve));
        await testDb.destroy();
    });

    test("badge-leak: a Team A monitor attached to a Team B public status page must NOT be reported public", async () => {
        const teamA = await R.store(
            Object.assign(R.dispense("team"), { name: "A", slug: "badge-team-a", is_system: false, active: true })
        );
        const teamB = await R.store(
            Object.assign(R.dispense("team"), { name: "B", slug: "badge-team-b", is_system: false, active: true })
        );

        const monitorId = await createMonitor(teamA, "Team A Monitor");
        const statusPageId = await createStatusPage(teamB, "badge-leak-page");
        await createPublicGroupWithMonitor(statusPageId, monitorId, true);

        const { status, body } = await getText(port, `/api/badge/${monitorId}/status`);
        assert.strictEqual(status, 200);
        assert.ok(body.includes("N/A"), `expected the badge-leak to be closed (N/A), got: ${body}`);
        assert.ok(!body.includes(">Up<"), "must not leak the real UP status across teams");
    });

    test("same-team: a monitor attached to its OWN team's public status page IS correctly reported public", async () => {
        const teamC = await R.store(
            Object.assign(R.dispense("team"), { name: "C", slug: "badge-team-c", is_system: false, active: true })
        );

        const monitorId = await createMonitor(teamC, "Team C Monitor");
        const statusPageId = await createStatusPage(teamC, "badge-same-team-page");
        await createPublicGroupWithMonitor(statusPageId, monitorId, true);

        const { status, body } = await getText(port, `/api/badge/${monitorId}/status`);
        assert.strictEqual(status, 200);
        assert.ok(
            !body.includes("N/A"),
            `expected the real status to be shown for a same-team public page, got: ${body}`
        );
    });

    test("a non-public group (even same-team) is still not reported public", async () => {
        const teamD = await R.store(
            Object.assign(R.dispense("team"), { name: "D", slug: "badge-team-d", is_system: false, active: true })
        );

        const monitorId = await createMonitor(teamD, "Team D Monitor");
        const statusPageId = await createStatusPage(teamD, "badge-private-page");
        await createPublicGroupWithMonitor(statusPageId, monitorId, false);

        const { body } = await getText(port, `/api/badge/${monitorId}/status`);
        assert.ok(body.includes("N/A"), "a non-public group must never make the badge public");
    });
});
