const { describe, test } = require("node:test");
const assert = require("node:assert");
const { UptimeCalculator } = require("../../server/uptime-calculator");
const dayjs = require("dayjs");
const { UP } = require("../../src/util");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

/**
 * Characterization baseline for ADR-0013 (anomaly detection, TASK-A1-0).
 * Pins down the read/write ordering between UptimeCalculator.update() and
 * getData()/getDataArray() WITHIN THE SAME TICK -- this determines how the
 * future anomaly detector (TASK-A1-2) must query its historical baseline to
 * avoid comparing the current sample against a window that already contains
 * itself. Written before the detector exists, against the real (already
 * well-tested) UptimeCalculator class -- no production code touched.
 */
describe("UptimeCalculator - same-tick update()/getData() ordering (ADR-0013 baseline)", () => {
    test("getDataArray(1) called right after update() reflects the JUST-WRITTEN current bucket -- the contamination risk is real", async () => {
        UptimeCalculator.currentDate = dayjs.utc("2026-01-01T00:00:00.000Z");
        const c = new UptimeCalculator();

        await c.update(UP, 100);

        const [mostRecent] = c.getDataArray(1, "minute");
        assert.strictEqual(mostRecent.avgPing, 100, "the bucket update() just wrote is immediately visible to a reader");
        assert.strictEqual(
            mostRecent.timestamp,
            c.getMinutelyKey(UptimeCalculator.currentDate),
            "the returned bucket's key IS the current (in-progress) minute, not a prior/complete one"
        );
    });

    test("getData(1) (the aggregate, not the array) also includes the current in-progress bucket in its average", async () => {
        UptimeCalculator.currentDate = dayjs.utc("2026-01-01T00:05:00.000Z");
        const c = new UptimeCalculator();

        await c.update(UP, 250);

        const aggregate = c.getData(1, "minute");
        assert.strictEqual(aggregate.avgPing, 250, "a naive 1-bucket aggregate query is entirely the just-written sample");
    });

    test("a detector wanting N PRIOR buckets must fetch N+1 and drop the head -- getDataArray(2)[0] is the current bucket, [1] is the untouched prior one", async () => {
        UptimeCalculator.currentDate = dayjs.utc("2026-01-01T00:10:00.000Z");
        const c = new UptimeCalculator();
        await c.update(UP, 50); // establishes the "prior" minute's baseline

        UptimeCalculator.currentDate = dayjs.utc("2026-01-01T00:11:00.000Z");
        await c.update(UP, 999); // the "current" sample under evaluation

        const [current, prior] = c.getDataArray(2, "minute");

        assert.strictEqual(current.avgPing, 999, "index 0 is always the in-progress current bucket");
        assert.strictEqual(prior.avgPing, 50, "index 1 is the prior, untouched-by-this-tick bucket");
        assert.notStrictEqual(
            current.timestamp,
            prior.timestamp,
            "distinct minute boundaries produce distinct bucket keys -- confirms bucketing itself, not just ping values, separates them"
        );
    });

    test("querying a window with NO prior data (first-ever beat) does not crash and does not fabricate history", async () => {
        UptimeCalculator.currentDate = dayjs.utc("2026-01-01T00:20:00.000Z");
        const c = new UptimeCalculator();

        await c.update(UP, 42);

        const window = c.getDataArray(5, "minute");
        assert.strictEqual(window.length, 1, "only the one real bucket exists -- getDataArray() does not pad empty buckets into the array");
        assert.strictEqual(window[0].avgPing, 42);
    });

    test("two updates within the SAME minute average together in the current bucket (both are 'today', neither is history)", async () => {
        UptimeCalculator.currentDate = dayjs.utc("2026-01-01T00:30:00.000Z");
        const c = new UptimeCalculator();

        await c.update(UP, 100);
        await c.update(UP, 200);

        const [onlyBucket] = c.getDataArray(1, "minute");
        assert.strictEqual(onlyBucket.avgPing, 150, "same-bucket samples are averaged together, not kept as separate history points");
    });
});
