/**
 * Number of seconds in each time-bucket type.
 * @type {{day: number, hour: number, minute: number}}
 */
const bucketSeconds = {
    day: 86400,
    hour: 3600,
    minute: 60,
};

/**
 * Truncate a date to the start of its minutely bucket and return the unix timestamp (seconds).
 * @param {import("dayjs").Dayjs} date The heartbeat date
 * @returns {number} Timestamp in seconds
 */
function minutelyKey(date) {
    // Truncate value to minutes (e.g. 2021-01-01 12:34:56 -> 2021-01-01 12:34:00)
    return date.startOf("minute").unix();
}

/**
 * Truncate a date to the start of its hourly bucket and return the unix timestamp (seconds).
 * @param {import("dayjs").Dayjs} date The heartbeat date
 * @returns {number} Timestamp in seconds
 */
function hourlyKey(date) {
    // Truncate value to hours (e.g. 2021-01-01 12:34:56 -> 2021-01-01 12:00:00)
    return date.startOf("hour").unix();
}

/**
 * Truncate a date to the start of its daily bucket (UTC) and return the unix timestamp (seconds).
 * @param {import("dayjs").Dayjs} date The heartbeat date
 * @returns {number} Timestamp in seconds
 */
function dailyKey(date) {
    // Truncate value to start of day (e.g. 2021-01-01 12:34:56 -> 2021-01-01 00:00:00)
    // Considering if the user keep changing could affect the calculation, so use UTC time to avoid this problem.
    return date.utc().startOf("day").unix();
}

/**
 * Get the number of seconds spanned by a single bucket of the given type.
 * @param {"day" | "hour" | "minute"} type the type of data which is expected to be returned
 * @returns {number} Number of seconds per bucket
 * @throws {Error} If the type is invalid
 */
function secondsPerBucket(type) {
    const seconds = bucketSeconds[type];
    if (seconds === undefined) {
        throw new Error("Invalid type");
    }
    return seconds;
}

module.exports = {
    minutelyKey,
    hourlyKey,
    dailyKey,
    secondsPerBucket,
};
