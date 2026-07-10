process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const { EventEmitter, once } = require("node:events");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { UP, DOWN, PENDING } = require("../../src/util");

// beat() formats heartbeat.time via R.isoDateTimeMillis(dayjs.utc(...)) and
// parses it back the same way (dayjs.utc(previousBeat.time)) -- these plugins
// are normally registered by server.js's own bootstrap, which this
// standalone test file never requires. Same convention as
// test-uptime-calculator.js / test-monitor-send-notification.js.
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

/**
 * Characterization baseline for the `this.type === "push"` dead-man's-switch
 * branch inside Monitor.prototype.start()'s private beat() closure
 * (server/model/monitor.js, ~lines 502-539). Written as a design reference
 * for ADR-0015 (decision 5: a new server/monitor-types/otel.js watchdog "in
 * the mold of push"), against the REAL beat() code path -- driven end-to-end
 * via monitor.start(io), not a reimplementation. No production code touched.
 *
 * beat() is a private closure with no test seam, so these tests drive it the
 * only way a caller can: construct a real, stored push-type Monitor bean
 * (idiom borrowed from test-monitor-model.js's createMonitor()) and call the
 * real `start(io)`, then observe outcomes via a mock `io` (a `to().emit()`
 * stand-in backed by an EventEmitter -- getTotalClientInRoom() reports 0
 * clients for it, matching production's "no connected browsers" shape) and
 * direct heartbeat-table reads. No existing test in this repo drives
 * start()/beat() this way (test-monitor-anomaly-detection.js and
 * test-monitor-notification-routing-integration.js explicitly call the
 * beat()-adjacent static helpers directly and document *avoiding* the full
 * beat() pipeline as out of scope for their own files) -- this file is the
 * first to do so, deliberately, because ADR-0015 needs the REAL watchdog
 * behavior as its design reference, not a paraphrase of it.
 *
 * Real setTimeout calls drive the push watchdog (the initial "delay push
 * type" timer plus beat()'s own reschedule), so these tests use a short
 * (1s) monitor interval and wait on real wall-clock timers. Every test stops
 * the monitor in a `finally` so no timer outlives the test, and a
 * process-wide unhandledRejection listener (registered in before()) fails
 * the run if beat()'s internal watchdog Error (used purely for control flow,
 * see below) ever escapes uncaught.
 */

const MONITOR_INTERVAL_SEC = 1;
const PUSH_BUFFER_MS = 1000; // hardcoded bufferTime inside beat()'s push branch

/**
 * Sleep for the given number of milliseconds.
 * @param {number} ms Milliseconds to wait.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a mock Socket.io server sufficient for beat()'s push-type path:
 * `io.to(room).emit(...)` (heartbeat broadcast) and Monitor.sendStats()'s
 * `getTotalClientInRoom(io, room)` (which returns 0 whenever `io.sockets` is
 * absent -- see server/util-server/misc.js -- so sendStats() takes its
 * "no clients" short-circuit and never needs a real adapter).
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
 * Wait for the mock io's "heartbeat" socket emit -- the
 * `io.to(room).emit("heartbeat", bean.toJSON())` call inside beat()'s
 * general insert path (monitor.js, "Send to socket" section) -- or fail
 * after timeoutMs. This event is NOT fired by the early-return "fresh
 * previous UP heartbeat, no need to insert" push branch, which is exactly
 * what the "no insert" test below exploits to prove that branch never
 * reaches this point.
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
 * Dispense + store a push-type Monitor bean, reloaded from the DB so
 * column defaults SQLite applies at insert time are reflected in memory
 * (same rationale as test-monitor-model.js's createMonitor()). maxretries
 * defaults to 0 so every "stale" watchdog trip lands directly on DOWN
 * rather than being absorbed into a PENDING retry -- the scenario this file
 * characterizes. The returned bean already has Monitor's start()/stop()
 * methods (server/model/monitor.js) -- no explicit `require()` of that
 * module is needed here, since testDb.create() (via Database.connect())
 * calls R.autoloadModels("./server/model"), which registers every model
 * class, including Monitor, before any test runs.
 * @param {object} fields Monitor fields to assign (camelCase, matching bean property names)
 * @returns {Promise<import("../../server/model/monitor")>} The stored monitor bean
 */
async function createPushMonitor(fields = {}) {
    const bean = R.dispense("monitor");
    bean.import({
        name: "push watchdog test monitor",
        type: "push",
        interval: MONITOR_INTERVAL_SEC,
        maxretries: 0,
        push_token: "push-watchdog-test-token",
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
 * Dispense + store a heartbeat bean directly (bypassing beat()), formatted
 * the same way beat() itself writes heartbeat.time
 * (R.isoDateTimeMillis(dayjs.utc(...))) so the push branch's
 * `dayjs.utc(previousBeat.time)` parse round-trips exactly like a
 * real prior beat would have left behind.
 * @param {number} monitorId The owning monitor's id.
 * @param {object} fields status (required) and secondsAgo (default 0, how
 * far in the past `time` should be stamped).
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

describe("Monitor push-type watchdog - beat() characterization (ADR-0015 design reference)", () => {
    const testDb = new TestDB("./data/test-monitor-push-watchdog");
    /** @type {Array<unknown>} */
    let unhandledRejections;

    /**
     * Records any unhandled promise rejection during a test so it can be
     * asserted against. If beat()'s internal watchdog Error (constructed
     * purely for its own try/catch control flow, monitor.js ~line 522/538)
     * ever escaped uncaught, it would surface here.
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
        // Each test's own finally{} calls monitor.stop() as soon as it has
        // what it needs (usually right after the "heartbeat" socket emit),
        // which sets isStop=true (so beat() won't schedule a NEW tick) but
        // does NOT wait for the CURRENTLY-RUNNING beat() invocation to
        // finish its own remaining awaits (forwardHeartbeatToMaster's
        // Settings.get() calls, prometheus.update, ...). Settings.get()
        // lazily re-arms Settings' 60s cache-cleaner setInterval whenever
        // it's not already running (server/settings.js) -- so a straggling
        // call landing AFTER stopCacheCleaner() below would re-arm an
        // interval nothing ever clears again, hanging the whole test
        // process instead of letting it exit. Discovered by running this
        // file standalone and observing the node process never exit even
        // though every test had already reported passing; confirmed via
        // process._getActiveHandles() in a throwaway repro script.
        await sleep(800);
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    beforeEach(() => {
        unhandledRejections = [];
    });

    test("no previous heartbeat: the very first beat does not throw -- it resolves and records a DOWN heartbeat (the correct 'no push has arrived yet' watchdog reading)", async () => {
        const monitor = await createPushMonitor({ name: "first-beat-monitor" });
        const { io, emitter } = createMockIo();

        try {
            await assert.doesNotReject(monitor.start(io));

            const payload = await waitForHeartbeatEmit(emitter);
            assert.strictEqual(payload.status, DOWN);
            assert.strictEqual(payload.msg, "No heartbeat in the time window");
            // isFirstBeat's throw sets bean.duration to the raw beatInterval
            // (not a msSinceLastBeat computation -- there is no previous beat
            // to measure from).
            assert.strictEqual(Number(payload.duration), MONITOR_INTERVAL_SEC);

            // Let R.store(bean), which runs after the socket emit, land.
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

    test("previous UP heartbeat within beatInterval+1000ms: no new heartbeat is inserted and status is not flipped (the early-return 'no need to insert' branch)", async () => {
        const monitor = await createPushMonitor({ name: "fresh-up-monitor" });
        const seed = await seedHeartbeat(monitor.id, { status: UP, secondsAgo: 0 });
        const { io, emitter } = createMockIo();
        let heartbeatEmitted = false;
        emitter.on("heartbeat", () => {
            heartbeatEmitted = true;
        });

        try {
            await monitor.start(io);
            // The initial "delay push type" timer fires after exactly
            // `interval` seconds; wait comfortably past it (but well short of
            // the *second* scheduled tick, ~PUSH_BUFFER_MS later) before
            // asserting nothing happened.
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

    test("previous heartbeat older than beatInterval+1000ms: monitor goes DOWN with duration reflecting msSinceLastBeat", async () => {
        const monitor = await createPushMonitor({ name: "stale-by-time-monitor" });
        await seedHeartbeat(monitor.id, { status: UP, secondsAgo: 8 });
        const { io, emitter } = createMockIo();

        try {
            await monitor.start(io);
            const payload = await waitForHeartbeatEmit(emitter);

            assert.strictEqual(payload.status, DOWN);
            assert.strictEqual(payload.msg, "No heartbeat in the time window");
            // msSinceLastBeat =~ 8s seed age + ~1s initial push delay =~ 9s,
            // comfortably past the 1s+1000ms=2s staleness threshold. Loose
            // lower bound absorbs real scheduling jitter.
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

    test("previous heartbeat status DOWN (even though recent) also trips the stale branch -- the OR condition, not elapsed time alone", async () => {
        const monitor = await createPushMonitor({ name: "recent-down-monitor" });
        await seedHeartbeat(monitor.id, { status: DOWN, secondsAgo: 0 });
        const { io, emitter } = createMockIo();

        try {
            await monitor.start(io);
            const payload = await waitForHeartbeatEmit(emitter);

            assert.strictEqual(payload.status, DOWN);
            assert.strictEqual(payload.msg, "No heartbeat in the time window");
            // Seed was fresh (secondsAgo: 0) -- msSinceLastBeat is small,
            // nowhere near the beatInterval+1000ms threshold. It must be the
            // "previous status !== UP" arm of the OR that trips staleness
            // HERE, on the very first tick -- not elapsed time on a delayed
            // second tick. Duration is Math.round(msSinceLastBeat/1000)
            // regardless of which OR-arm fired, so an EXACT match against
            // the raw interval (not a loose "<=" bound) is what makes this
            // test fail if the status-arm is ever removed: without it, the
            // first tick would take the "reschedule" branch instead (no
            // trip), and staleness would only fire ~1 interval later via
            // elapsed time alone -- duration would be ~2x this value, not
            // caught by a loose upper bound.
            assert.strictEqual(
                Number(payload.duration),
                MONITOR_INTERVAL_SEC,
                `expected an immediate, status-driven trip (duration === ${MONITOR_INTERVAL_SEC}), got ${payload.duration} -- ` +
                    "a larger value means this fired on a later tick via elapsed time, not the status check"
            );
        } finally {
            await monitor.stop();
        }

        assert.deepStrictEqual(unhandledRejections, []);
    });

    test("previous heartbeat status PENDING (even though recent) also trips the stale branch", async () => {
        const monitor = await createPushMonitor({ name: "recent-pending-monitor" });
        await seedHeartbeat(monitor.id, { status: PENDING, secondsAgo: 0 });
        const { io, emitter } = createMockIo();

        try {
            await monitor.start(io);
            const payload = await waitForHeartbeatEmit(emitter);

            assert.strictEqual(payload.status, DOWN);
            assert.strictEqual(payload.msg, "No heartbeat in the time window");
            // Same exact-match rationale as the "recent-down" test above --
            // see the comment there.
            assert.strictEqual(
                Number(payload.duration),
                MONITOR_INTERVAL_SEC,
                `expected an immediate, status-driven trip (duration === ${MONITOR_INTERVAL_SEC}), got ${payload.duration} -- ` +
                    "a larger value means this fired on a later tick via elapsed time, not the status check"
            );
        } finally {
            await monitor.stop();
        }

        assert.deepStrictEqual(unhandledRejections, []);
    });
});
