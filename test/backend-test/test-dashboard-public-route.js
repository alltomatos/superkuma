process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server", "error_prometheus"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { UptimeCalculator } = require("../../server/uptime-calculator");
const { UP } = require("../../src/util");

/**
 * Reach into the express.Router() exported by dashboard-router.js and pull out
 * the real handler registered for `/api/panel/:slug`. The route is
 * registered as `router.get(path, cache(...), handler)`, so the handler is the
 * LAST layer on the route stack (the cache middleware is index 0). Same
 * technique as test-api-push-endpoint.js -- exercises the real code path.
 * @returns {Function} The real async (request, response) => {...} data handler.
 * @throws {Error} If the route can't be located (registration changed).
 */
function extractDataHandler() {
    const router = require("../../server/routers/dashboard-router.js");
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === "/api/panel/:slug") {
            const stack = layer.route.stack;
            return stack[stack.length - 1].handle;
        }
    }
    throw new Error("Could not locate /api/panel/:slug in dashboard-router.js's route stack");
}

/**
 * Build a minimal mock Express response capturing status + body + headers.
 * @returns {object} A mock response.
 */
function mockRes() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(obj) {
            this.body = obj;
            return this;
        },
        send(obj) {
            this.body = obj;
            return this;
        },
        header(key, value) {
            this.headers[key] = value;
            return this;
        },
        set(key, value) {
            this.headers[key] = value;
            return this;
        },
        removeHeader() {},
    };
}

/**
 * Invoke the public data handler for a slug and return the mock response.
 * @param {string} slug The slug to request.
 * @returns {Promise<object>} The mock response after the handler runs.
 */
async function callData(slug) {
    const handler = extractDataHandler();
    const res = mockRes();
    await handler({ params: { slug }, headers: {}, query: {} }, res);
    return res;
}

let teamCounter = 0;

/**
 * Create a fresh team and return its id.
 * @returns {Promise<number>} The new team id.
 */
async function createTeam() {
    teamCounter += 1;
    const slug = `dash-public-team-${teamCounter}`;
    await R.knex("team").insert({ name: slug, slug, is_system: false, active: true });
    return (await R.knex("team").where("slug", slug).first()).id;
}

/**
 * Create a dashboard row directly.
 * @param {object} fields Dashboard fields.
 * @param {number} fields.teamId The owning team id.
 * @param {string} fields.slug The dashboard slug.
 * @param {boolean} fields.published Whether the dashboard is publicly published.
 * @param {string} fields.title The dashboard title, or undefined to default to the slug.
 * @returns {Promise<number>} The new dashboard id.
 */
async function createDashboard({ teamId, slug, published, title }) {
    const bean = R.dispense("dashboard");
    bean.team_id = teamId;
    bean.title = title || slug;
    bean.slug = slug;
    bean.published = published ? 1 : 0;
    await R.store(bean);
    return bean.id;
}

/**
 * Create a monitor owned by a team, with a warmed UptimeCalculator + one
 * heartbeat so the public route's per-monitor data path has real data.
 * @param {number} teamId The owning team id.
 * @returns {Promise<number>} The monitor id.
 */
async function createMonitorWithBeat(teamId) {
    const bean = R.dispense("monitor");
    bean.name = `dash-public-monitor-${Date.now()}-${Math.random()}`;
    bean.type = "http";
    bean.url = "https://example.com";
    bean.interval = 60;
    bean.team_id = teamId;
    const monitorId = await R.store(bean);

    const hb = R.dispense("heartbeat");
    hb.monitor_id = monitorId;
    hb.status = UP;
    hb.msg = "200 OK";
    hb.ping = 42;
    hb.time = R.isoDateTime();
    hb.important = false;
    hb.duration = 0;
    hb.down_count = 0;
    await R.store(hb);

    // Warm the cached UptimeCalculator for this monitor so get24Hour() has data
    // (the handler fetches the same cached instance via getUptimeCalculator).
    const uc = await UptimeCalculator.getUptimeCalculator(monitorId);
    await uc.update(UP, 42);

    return monitorId;
}

/**
 * Attach a panel to a dashboard.
 * @param {number} dashboardId The dashboard id.
 * @param {number} monitorId The monitor id.
 * @returns {Promise<void>}
 */
async function addPanel(dashboardId, monitorId) {
    const bean = R.dispense("dashboard_widget");
    bean.dashboard_id = dashboardId;
    bean.monitor_id = monitorId;
    bean.kind = "metric_gauge";
    bean.pos_x = 0;
    bean.pos_y = 0;
    bean.width = 4;
    bean.height = 4;
    bean.sort_order = 0;
    await R.store(bean);
}

describe("public dashboard route (ADR-0017 /api/panel/:slug)", () => {
    const testDb = new TestDB("./data/test-dashboard-public-route");

    before(async () => {
        await testDb.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("an UNPUBLISHED dashboard returns 404, never its content", async () => {
        const teamId = await createTeam();
        await createDashboard({ teamId, slug: "secret-internal", published: false });

        const res = await callData("secret-internal");

        assert.strictEqual(res.statusCode, 404);
        assert.strictEqual(res.body.status, "fail");
        assert.ok(!res.body.dashboard, "an unpublished dashboard must not leak its content");
    });

    test("a nonexistent slug returns 404 (indistinguishable from unpublished)", async () => {
        const res = await callData("no-such-dashboard");
        assert.strictEqual(res.statusCode, 404);
    });

    test("a malformed slug (uppercase/spaces) returns 404", async () => {
        const res = await callData("Not A Slug");
        assert.strictEqual(res.statusCode, 404);
    });

    test("a PUBLISHED dashboard returns 200 with non-sensitive meta (no teamId, no published flag)", async () => {
        const teamId = await createTeam();
        await createDashboard({
            teamId,
            slug: "public-ops",
            published: true,
            title: "Public Ops",
        });

        const res = await callData("public-ops");

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.dashboard.title, "Public Ops");
        assert.strictEqual(res.body.dashboard.slug, "public-ops");
        assert.deepStrictEqual(res.body.panels, []);
        assert.strictEqual(res.body.dashboard.teamId, undefined, "public payload must not leak teamId");
        assert.strictEqual(res.body.dashboard.published, undefined, "public payload must not echo the published flag");
        // Regression test for a mutation-testing gap found during the ADR-0017
        // adversarial verification (2026-07-12): a raw `{ ...dashboard, ... }`
        // spread of the redbean-node Bean (instead of the explicit whitelist
        // object literal) went UNCAUGHT by the two assertions above, because a
        // Bean's own-enumerable properties are underscore-prefixed internals
        // (`_teamId`, `_published`, `_id`, `_createdDate`, plus a `beanMeta`
        // object) -- never the camelCase `teamId`/`published` names those
        // assertions check for. A spread leaks the real internal team id and
        // published flag under those different key names instead. Asserting
        // the exact key set closes that gap regardless of what name a future
        // leak might use.
        assert.deepStrictEqual(
            Object.keys(res.body.dashboard).sort(),
            ["description", "refreshInterval", "slug", "theme", "title"],
            "the public dashboard payload must contain exactly the whitelisted fields -- nothing else"
        );
    });

    test("a PUBLISHED dashboard returns its panels + per-monitor public heartbeats", async () => {
        const teamId = await createTeam();
        const dashboardId = await createDashboard({ teamId, slug: "public-with-panel", published: true });
        const monitorId = await createMonitorWithBeat(teamId);
        await addPanel(dashboardId, monitorId);

        const res = await callData("public-with-panel");

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.panels.length, 1);
        assert.strictEqual(res.body.panels[0].monitorId, monitorId);
        assert.strictEqual(res.body.panels[0].kind, "metric_gauge");
        assert.ok(res.body.heartbeatList[monitorId], "the panel's monitor should have a public heartbeat list");
        // The public heartbeat view must never carry the raw internal monitor
        // config -- only the whitelisted fields Heartbeat.toPublicJSON exposes.
        const beat = res.body.heartbeatList[monitorId][0];
        assert.ok(beat, "there should be at least one public heartbeat");
        assert.strictEqual(beat.url, undefined, "public heartbeat must not carry monitor config");
    });
});
