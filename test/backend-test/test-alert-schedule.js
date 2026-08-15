const { describe, test } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));

const { isWithinAlertSchedule } = require("../../server/util-server/alert-schedule");

// Wednesday 2026-08-19, 14:30 UTC -- a fixed, deterministic "now" for every test below.
const WEDNESDAY_AFTERNOON = dayjs.utc("2026-08-19T14:30:00Z");

describe("alert-schedule.js: isWithinAlertSchedule()", () => {
    test("always allowed when the schedule is missing", () => {
        assert.strictEqual(isWithinAlertSchedule(null, "UTC", WEDNESDAY_AFTERNOON), true);
        assert.strictEqual(isWithinAlertSchedule(undefined, "UTC", WEDNESDAY_AFTERNOON), true);
    });

    test("always allowed when alertScheduleEnabled is false", () => {
        assert.strictEqual(
            isWithinAlertSchedule(
                {
                    alertScheduleEnabled: false,
                    alertScheduleWeekdays: [],
                    alertScheduleStartTime: "09:00",
                    alertScheduleEndTime: "10:00",
                },
                "UTC",
                WEDNESDAY_AFTERNOON
            ),
            true
        );
    });

    test("empty weekdays list means every day is allowed", () => {
        assert.strictEqual(
            isWithinAlertSchedule(
                {
                    alertScheduleEnabled: true,
                    alertScheduleWeekdays: [],
                    alertScheduleStartTime: "00:00",
                    alertScheduleEndTime: "23:59",
                    alertScheduleTimezone: "UTC",
                },
                "UTC",
                WEDNESDAY_AFTERNOON
            ),
            true
        );
    });

    test("blocks a weekday not in the allowed list", () => {
        assert.strictEqual(
            isWithinAlertSchedule(
                {
                    // Wednesday is 3; leave it out.
                    alertScheduleEnabled: true,
                    alertScheduleWeekdays: [1, 2, 4, 5],
                    alertScheduleStartTime: "00:00",
                    alertScheduleEndTime: "23:59",
                    alertScheduleTimezone: "UTC",
                },
                "UTC",
                WEDNESDAY_AFTERNOON
            ),
            false
        );
    });

    test("allows the current weekday when it's in the allowed list", () => {
        assert.strictEqual(
            isWithinAlertSchedule(
                {
                    alertScheduleEnabled: true,
                    alertScheduleWeekdays: [3], // Wednesday
                    alertScheduleStartTime: "00:00",
                    alertScheduleEndTime: "23:59",
                    alertScheduleTimezone: "UTC",
                },
                "UTC",
                WEDNESDAY_AFTERNOON
            ),
            true
        );
    });

    test("14:30 is inside a 08:00-18:00 working-hours window", () => {
        assert.strictEqual(
            isWithinAlertSchedule(
                {
                    alertScheduleEnabled: true,
                    alertScheduleWeekdays: [],
                    alertScheduleStartTime: "08:00",
                    alertScheduleEndTime: "18:00",
                    alertScheduleTimezone: "UTC",
                },
                "UTC",
                WEDNESDAY_AFTERNOON
            ),
            true
        );
    });

    test("14:30 is outside a 08:00-12:00 working-hours window", () => {
        assert.strictEqual(
            isWithinAlertSchedule(
                {
                    alertScheduleEnabled: true,
                    alertScheduleWeekdays: [],
                    alertScheduleStartTime: "08:00",
                    alertScheduleEndTime: "12:00",
                    alertScheduleTimezone: "UTC",
                },
                "UTC",
                WEDNESDAY_AFTERNOON
            ),
            false
        );
    });

    test("14:30 is inside an overnight 22:00-06:00 window's complement check (blocked)", () => {
        // A firewall's "do not alert" quiet-hours window of 22:00-06:00 means
        // 14:30 (midday) is well outside it.
        assert.strictEqual(
            isWithinAlertSchedule(
                {
                    alertScheduleEnabled: true,
                    alertScheduleWeekdays: [],
                    alertScheduleStartTime: "22:00",
                    alertScheduleEndTime: "06:00",
                    alertScheduleTimezone: "UTC",
                },
                "UTC",
                WEDNESDAY_AFTERNOON
            ),
            false
        );
    });

    test("23:00 is inside an overnight 22:00-06:00 window (allowed)", () => {
        const lateNight = WEDNESDAY_AFTERNOON.hour(23).minute(0);
        assert.strictEqual(
            isWithinAlertSchedule(
                {
                    alertScheduleEnabled: true,
                    alertScheduleWeekdays: [],
                    alertScheduleStartTime: "22:00",
                    alertScheduleEndTime: "06:00",
                    alertScheduleTimezone: "UTC",
                },
                "UTC",
                lateNight
            ),
            true
        );
    });

    test("03:00 (past midnight) is inside an overnight 22:00-06:00 window (allowed)", () => {
        const earlyMorning = WEDNESDAY_AFTERNOON.hour(3).minute(0);
        assert.strictEqual(
            isWithinAlertSchedule(
                {
                    alertScheduleEnabled: true,
                    alertScheduleWeekdays: [],
                    alertScheduleStartTime: "22:00",
                    alertScheduleEndTime: "06:00",
                    alertScheduleTimezone: "UTC",
                },
                "UTC",
                earlyMorning
            ),
            true
        );
    });

    test("SAME_AS_SERVER (or missing) timezone falls back to the provided server timezone", () => {
        const schedule = {
            alertScheduleEnabled: true,
            alertScheduleWeekdays: [],
            alertScheduleStartTime: "00:00",
            alertScheduleEndTime: "23:59",
        };
        assert.strictEqual(isWithinAlertSchedule(schedule, "America/Sao_Paulo", WEDNESDAY_AFTERNOON), true);
        assert.strictEqual(
            isWithinAlertSchedule(
                { ...schedule, alertScheduleTimezone: "SAME_AS_SERVER" },
                "America/Sao_Paulo",
                WEDNESDAY_AFTERNOON
            ),
            true
        );
    });

    test("an explicit schedule timezone overrides the server timezone", () => {
        // 14:30 UTC is 11:30 in America/Sao_Paulo (UTC-3), still inside 08:00-18:00 there,
        // but 14:30 UTC itself would be outside an 08:00-12:00 window evaluated in UTC.
        assert.strictEqual(
            isWithinAlertSchedule(
                {
                    alertScheduleEnabled: true,
                    alertScheduleWeekdays: [],
                    alertScheduleStartTime: "08:00",
                    alertScheduleEndTime: "12:00",
                    alertScheduleTimezone: "America/Sao_Paulo",
                },
                "UTC",
                WEDNESDAY_AFTERNOON
            ),
            true
        );
    });
});
