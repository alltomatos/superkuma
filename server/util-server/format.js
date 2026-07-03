const { badgeConstants } = require("../../src/util");
const iconv = require("iconv-lite");
const chardet = require("chardet");
const chroma = require("chroma-js");
const crypto = require("crypto");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));

/**
 * Convert unknown string to UTF8
 * @param {Uint8Array} body Buffer
 * @returns {string} UTF8 string
 */
exports.convertToUTF8 = (body) => {
    const guessEncoding = chardet.detect(body);
    const str = iconv.decode(body, guessEncoding);
    return str.toString();
};

/**
 * Returns a color code in hex format based on a given percentage:
 * 0% => hue = 10 => red
 * 100% => hue = 90 => green
 * @param {number} percentage float, 0 to 1
 * @param {number} maxHue Maximum hue - int
 * @param {number} minHue Minimum hue - int
 * @returns {string} Color in hex
 */
exports.percentageToColor = (percentage, maxHue = 90, minHue = 10) => {
    const hue = percentage * (maxHue - minHue) + minHue;
    try {
        return chroma(`hsl(${hue}, 90%, 40%)`).hex();
    } catch (err) {
        return badgeConstants.naColor;
    }
};

/**
 * Joins and array of string to one string after filtering out empty values
 * @param {string[]} parts Strings to join
 * @param {string} connector Separator for joined strings
 * @returns {string} Joined strings
 */
exports.filterAndJoin = (parts, connector = "") => {
    return parts.filter((part) => !!part && part !== "").join(connector);
};

/**
 * Convert timezone of time object
 * @param {object} obj Time object to update
 * @param {string} timezone New timezone to set
 * @param {boolean} timeObjectToUTC Convert time object to UTC
 * @returns {object} Time object with updated timezone
 */
function timeObjectConvertTimezone(obj, timezone, timeObjectToUTC = true) {
    let offsetString;

    if (timezone) {
        offsetString = dayjs().tz(timezone).format("Z");
    } else {
        offsetString = dayjs().format("Z");
    }

    let hours = parseInt(offsetString.substring(1, 3));
    let minutes = parseInt(offsetString.substring(4, 6));

    if ((timeObjectToUTC && offsetString.startsWith("+")) || (!timeObjectToUTC && offsetString.startsWith("-"))) {
        hours *= -1;
        minutes *= -1;
    }

    obj.hours += hours;
    obj.minutes += minutes;

    // Handle out of bound
    if (obj.minutes < 0) {
        obj.minutes += 60;
        obj.hours--;
    } else if (obj.minutes > 60) {
        obj.minutes -= 60;
        obj.hours++;
    }

    if (obj.hours < 0) {
        obj.hours += 24;
    } else if (obj.hours > 24) {
        obj.hours -= 24;
    }

    return obj;
}

/**
 * Convert time object to UTC
 * @param {object} obj Object to convert
 * @param {string} timezone Timezone of time object
 * @returns {object} Updated time object
 */
module.exports.timeObjectToUTC = (obj, timezone = undefined) => {
    return timeObjectConvertTimezone(obj, timezone, true);
};

/**
 * Convert time object to local time
 * @param {object} obj Object to convert
 * @param {string} timezone Timezone to convert to
 * @returns {object} Updated object
 */
module.exports.timeObjectToLocal = (obj, timezone = undefined) => {
    return timeObjectConvertTimezone(obj, timezone, false);
};

module.exports.SHAKE256_LENGTH = 16;

/**
 * @param {string} data The data to be hashed
 * @param {number} len Output length of the hash
 * @returns {string} The hashed data in hex format
 */
module.exports.shake256 = (data, len) => {
    if (!data) {
        return "";
    }
    return crypto.createHash("shake256", { outputLength: len }).update(data).digest("hex");
};

/**
 * Encode user and password to Base64 encoding
 * for HTTP "basic" auth, as per RFC-7617
 * @param {string|null} user - The username (defaults to empty string if null/undefined)
 * @param {string|null} pass - The password (defaults to empty string if null/undefined)
 * @returns {string} Encoded Base64 string
 */
function encodeBase64(user, pass) {
    return Buffer.from(`${user || ""}:${pass || ""}`).toString("base64");
}
module.exports.encodeBase64 = encodeBase64;
