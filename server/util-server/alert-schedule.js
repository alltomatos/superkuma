const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../modules/dayjs/plugin/timezone"));

/**
 * Check whether the current moment falls inside a notification's configured
 * alert delivery schedule (quiet hours), so alerts are not delivered outside
 * a team's working hours.
 * @param {object} schedule Schedule config as stored on the notification.
 * @param {boolean} schedule.alertScheduleEnabled Whether the schedule restricts delivery at all.
 * @param {number[]} schedule.alertScheduleWeekdays Allowed weekdays (0=Sun..6=Sat). Empty/missing = every day.
 * @param {string} schedule.alertScheduleStartTime Window start, "HH:mm".
 * @param {string} schedule.alertScheduleEndTime Window end, "HH:mm". May be before start for an overnight window.
 * @param {string} schedule.alertScheduleTimezone IANA timezone, or "SAME_AS_SERVER" to use serverTimezone.
 * @param {string} serverTimezone Timezone to use when the schedule has no timezone override.
 * @param {dayjs.Dayjs} referenceMoment Moment to evaluate against, injectable for tests. Defaults to now.
 * @returns {boolean} True if delivery is allowed right now.
 */
function isWithinAlertSchedule(schedule, serverTimezone, referenceMoment = dayjs()) {
    if (!schedule || !schedule.alertScheduleEnabled) {
        return true;
    }

    const timezone =
        !schedule.alertScheduleTimezone || schedule.alertScheduleTimezone === "SAME_AS_SERVER"
            ? serverTimezone
            : schedule.alertScheduleTimezone;

    const now = referenceMoment.tz(timezone);

    const weekdays = Array.isArray(schedule.alertScheduleWeekdays) ? schedule.alertScheduleWeekdays : [];
    if (weekdays.length > 0 && !weekdays.includes(now.day())) {
        return false;
    }

    const startMinutes = parseTimeToMinutes(schedule.alertScheduleStartTime, 0);
    const endMinutes = parseTimeToMinutes(schedule.alertScheduleEndTime, 24 * 60 - 1);
    const nowMinutes = now.hour() * 60 + now.minute();

    if (startMinutes <= endMinutes) {
        return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
    }

    // Overnight window (e.g. 22:00 -> 06:00): allowed on either side of midnight.
    return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

/**
 * Parse an "HH:mm" string into minutes since midnight.
 * @param {string} time Time string, e.g. "08:00".
 * @param {number} fallback Minutes to use when time is missing/invalid.
 * @returns {number} Minutes since midnight.
 */
function parseTimeToMinutes(time, fallback) {
    if (typeof time !== "string" || !/^\d{1,2}:\d{2}$/.test(time)) {
        return fallback;
    }
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
}

module.exports = {
    isWithinAlertSchedule,
};
