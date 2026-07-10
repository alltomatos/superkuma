process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const { EventEmitter, once } = require("node:events");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { UP, DOWN } = require("../../src/util");

// beat() formats heartbeat.time via R.isoDateTimeMillis(dayjs.utc(...)) and
// parses it back the same way -- these plugins are normally registered by
// server.js's own bootstrap, which this standalone test file never requires.
// Same convention as test-monitor-push-watchdog.js.
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

/**
 * Characterization coverage for the `this.type === "otel"` arm of the
 * dead-man's-switch branch inside Monitor.prototype.start()'s private beat()
 * closure (server/model/monitor.js, ADR-0015 TASK-A2-2), which widens the
 * existing `this.type === "push"` watchdog condition rather than
 * duplicating it. This file proves the otel branch behaves IDENTICALLY to
 * the already-characterized push watchdog in test-monitor-push-watchdog.js
 * for the two scenarios ADR-0015 explicitly calls out: no previous heartbeat
 * must not throw, and a stale/missing datapoint within the window goes DOWN
 * with "No heartbeat in the time window". See that file's own header
 * comment for the full rationale behind driving the real start()/beat()
 * pipeline (no test seam exists for beat(), it's a private closure) instead
 * of a reimplementation.
 */

const MONITOR_INTERVAL_SEC = 1;
const PUSH_BUFFER_MS = 1000; // hardcoded bufferTime inside beat()'s push/otel branch

/**
 * Sleep for the given number of milliseconds.
 * @param {number} ms Milliseconds to wait.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a mock Socket.io server, identical to test-monitor-push-watchdog.js's
 * createMockIo().
 * @returns {{io: object, emitter: EventEmitter}} The mock io and the
 * EventEmitter it forwards every `.emit()` call to, for test observation.
 */
function createMockIo() {
    const emitter = new EventEmitter();
    const io = {
        to() {
            return {
                emit(event, ...args) {
                    emitter.emit(event, ...args);
                },
            };
        },
    };
    return { io, emitter };
}

/**
 * Wait for the mock io's "heartbeat" socket emit, or fail after timeoutMs.
 * @param {EventEmitter} emitter The mock io's backing emitter.
 * @param {number} timeoutMs Max time to wait before failing (default 5000).
 * @returns {Promise<object>} The emitted heartbeat's bean.toJSON() payload.
 */
async function waitForHeartbeatEmit(emitter, timeoutMs = 5000) {
    const outcome = await Promise.race([
        once(emitter, "heartbeat").then(([payload]) => ({ fired: true, payload })),
        sleep(timeoutMs).then(() => ({ fired: false })),
    ]);
    if (!outcome.fired) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for a "heartbeat" socket emit`);
    }
    return outcome.payload;
}

/**
 * Dispense + store an otel-type Monitor bean, reloaded from the DB so column
 * defaults SQLite applies at insert time are reflected in memory. maxretries
 * defaults to 0 so every "stale" watchdog trip lands directly on DOWN rather
 * than being absorbed into a PENDING retry, same rationale as
 * test-monitor-push-watchdog.js's createPushMonitor().
 * @param {object} fields Monitor fields to assign (camelCase, matching bean property names)
 * @returns {Promise<import("../../server/model/monitor")>} The stored monitor bean
 */
async function createOtelMonitor(fields = {}) {
    const bean = R.dispense("monitor");
    bean.import({
        name: "otel watchdog test monitor",
        type: "otel",
        interval: MONITOR_INTERVAL_SEC,
        maxretries: 0,
        accepted_statuscodes_json: JSON.stringify(["200-299"]),
        conditions: "[]",
        kafkaProducerBrokers: "[]",
        kafkaProducerSaslOptions: "{}",
        rabbitmqNodes: "[]",
        otel_metric_name: "cpu.usage",
        otel_aggregation: "last",
        ...fields,
    });
    await R.store(bean);
    return await R.load("monitor", bean.id);
}

/**
 * Dispense + store a heartbeat bean directly (bypassing beat()/the telemetry
 * router), formatted the same way beat() itself writes heartbeat.time, same
 * idiom as test-monitor-push-watchdog.js's seedHeartbeat().
 * @param {number} monitorId The owning monitor's id.
 * @param {object} fields status (required) and secondsAgo (default 0, how
 *     far in the past `time` should be stamped).
 * @returns {Promise<import("redbean-node").Bean>} The stored heartbeat bean.
 */
async function seedHeartbeat(monitorId, fields) {
    const bean = R.dispense("heartbeat");
    bean.monitor_id = monitorId;
    bean.status = fields.status;
    bean.time = R.isoDateTimeMillis(dayjs.utc().subtract(fields.secondsAgo ?? 0, "second"));
    bean.msg = "seed heartbeat";
    bean.important = false;
    bean.duration = 0;
    bean.retries = 0;
    bean.downCount = 0;
    await R.store(bean);
    return bean;
}

describe("Monitor otel-type watchdog - beat() characterization (ADR-0015 TASK-A2-2)", () => {
    const testDb = new TestDB("./data/test-monitor-otel-watchdog");
    /** @type {Array<unknown>} */
    let unhandledRejections;

    /**
     * Records any unhandled promise rejection during a test so it can be
     * asserted against, same rationale as test-monitor-push-watchdog.js.
     * @param {unknown} reason The rejection reason.
     * @returns {void}
     */
    function onUnhandledRejection(reason) {
        unhandledRejections.push(reason);
    }

    before(async () => {
        await testDb.create();
        process.on("unhandledRejection", onUnhandledRejection);
    });

    after(async () => {
        process.off("unhandledRejection", onUnhandledRejection);
        // See test-monitor-push-watchdog.js's after() for why this sleep +
        // stopCacheCleaner() ordering matters (a straggling Settings.get()
        // call can re-arm a 60s interval that never gets cleared again).
        await sleep(800);
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    beforeEach(() => {
        unhandledRejections = [];
    });

    test("no previous heartbeat: the very first beat does not throw -- it resolves and records a DOWN heartbeat (the correct 'no datapoint has arrived yet' watchdog reading)", async () => {
        const monitor = await createOtelMonitor({ name: "otel-first-beat-monitor" });
        const { io, emitter } = createMockIo();

        try {
            await assert.doesNotReject(monitor.start(io));

            const payload = await waitForHeartbeatEmit(emitter);
            assert.strictEqual(payload.status, DOWN);
            assert.strictEqual(payload.msg, "No heartbeat in the time window");
            assert.strictEqual(Number(payload.duration), MONITOR_INTERVAL_SEC);

            await sleep(300);
            const rows = await R.find("heartbeat", "monitor_id = ? ORDER BY time DESC", [monitor.id]);
            assert.strictEqual(rows.length, 1, "the first beat must insert exactly one heartbeat row");
            assert.strictEqual(rows[0].status, DOWN);
            assert.strictEqual(rows[0].msg, "No heartbeat in the time window");
        } finally {
            await monitor.stop();
        }

        assert.deepStrictEqual(unhandledRejections, [], "no unhandled rejection should occur across the first beat");
    });

    test("previous UP heartbeat within beatInterval+1000ms: no new heartbeat is inserted and status is not flipped (the early-return 'no need to insert' branch, identical to push)", async () => {
        const monitor = await createOtelMonitor({ name: "otel-fresh-up-monitor" });
        const seed = await seedHeartbeat(monitor.id, { status: UP, secondsAgo: 0 });
        const { io, emitter } = createMockIo();
        let heartbeatEmitted = false;
        emitter.on("heartbeat", () => {
            heartbeatEmitted = true;
        });

        try {
            await monitor.start(io);
            await sleep(MONITOR_INTERVAL_SEC * 1000 + 700);

            assert.strictEqual(heartbeatEmitted, false, "the early-return branch must not emit a heartbeat");
            const rows = await R.find("heartbeat", "monitor_id = ? ORDER BY time DESC", [monitor.id]);
            assert.strictEqual(rows.length, 1, "no new heartbeat row should have been inserted");
            assert.strictEqual(rows[0].id, seed.id);
            assert.strictEqual(rows[0].status, UP, "the seeded heartbeat's status must remain untouched");
        } finally {
            await monitor.stop();
        }

        assert.deepStrictEqual(unhandledRejections, []);
    });

    test("previous heartbeat older than beatInterval+1000ms (a stale/missing datapoint): monitor goes DOWN with duration reflecting msSinceLastBeat", async () => {
        const monitor = await createOtelMonitor({ name: "otel-stale-by-time-monitor" });
        await seedHeartbeat(monitor.id, { status: UP, secondsAgo: 8 });
        const { io, emitter } = createMockIo();

        try {
            await monitor.start(io);
            const payload = await waitForHeartbeatEmit(emitter);

            assert.strictEqual(payload.status, DOWN);
            assert.strictEqual(payload.msg, "No heartbeat in the time window");
            assert.ok(
                Number(payload.duration) >= MONITOR_INTERVAL_SEC + PUSH_BUFFER_MS / 1000 + 5,
                `expected a duration reflecting ~8-9s of elapsed time, got ${payload.duration}`
            );

            await sleep(300);
            const rows = await R.find("heartbeat", "monitor_id = ? ORDER BY time DESC", [monitor.id]);
            assert.strictEqual(rows.length, 2, "the stale check must insert a new heartbeat alongside the seeded one");
            assert.strictEqual(rows[0].status, DOWN);
        } finally {
            await monitor.stop();
        }

        assert.deepStrictEqual(unhandledRejections, []);
    });
});
