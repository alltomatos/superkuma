const { BeanModel } = require("redbean-node/dist/bean-model");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const brotliDecompress = promisify(zlib.brotliDecompress);

/**
 * status:
 *      0 = DOWN
 *      1 = UP
 *      2 = PENDING
 *      3 = MAINTENANCE
 */
class Heartbeat extends BeanModel {
    /**
     * Return an object that ready to parse to JSON for public
     * Only show necessary data to public
     * @param {string} monitorType The owning monitor's type. When
     * "prometheus", a `metricValue` number is additionally extracted from the
     * (otherwise hidden) internal message -- see extractPublicMetricValue.
     * @returns {object} Object ready to parse
     */
    toPublicJSON(monitorType) {
        const obj = {
            status: this.status,
            time: this.time,
            msg: "", // Hide for public
            ping: this.ping,
        };

        if (monitorType === "prometheus") {
            const metricValue = Heartbeat.extractPublicMetricValue(this.msg);
            if (metricValue !== null) {
                obj.metricValue = metricValue;
            }
        }

        return obj;
    }

    /**
     * Extract the numeric PromQL result from a prometheus monitor's internal
     * heartbeat message, for public display (status-page gauges). Only ever
     * recognizes SuperKuma's own message format (see
     * server/monitor-types/prometheus.js) -- never forwards arbitrary message
     * text, so this cannot leak whatever an unrelated monitor type put in its
     * own `msg` (hostnames, error details, etc).
     * @param {string} msg The heartbeat's internal message
     * @returns {number|null} The numeric value, or null if not recognized
     */
    static extractPublicMetricValue(msg) {
        if (!msg) {
            return null;
        }
        const match = /^PromQL condition (?:passes|does not pass) \(([-\d.eE+]+)\s/.exec(msg);
        if (!match) {
            return null;
        }
        const num = Number(match[1]);
        return Number.isNaN(num) ? null : num;
    }

    /**
     * Return an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            monitorID: this._monitorId,
            status: this._status,
            time: this._time,
            msg: this._msg,
            ping: this._ping,
            important: this._important,
            duration: this._duration,
            retries: this._retries,
            response: this._response,
        };
    }

    /**
     * Return an object that ready to parse to JSON
     * @param {{ decodeResponse?: boolean }} opts Options for JSON serialization
     * @returns {Promise<object>} Object ready to parse
     */
    async toJSONAsync(opts) {
        return {
            monitorID: this._monitorId,
            status: this._status,
            time: this._time,
            msg: this._msg,
            ping: this._ping,
            important: this._important,
            duration: this._duration,
            retries: this._retries,
            response: opts?.decodeResponse ? await Heartbeat.decodeResponseValue(this._response) : undefined,
        };
    }

    /**
     * Decode compressed response payload stored in database.
     * @param {string|null} response Encoded response payload.
     * @returns {string|null} Decoded response payload.
     */
    static async decodeResponseValue(response) {
        if (!response) {
            return response;
        }

        try {
            // Offload brotli decode from main event loop to libuv thread pool
            return (await brotliDecompress(Buffer.from(response, "base64"))).toString("utf8");
        } catch (error) {
            return response;
        }
    }
}

module.exports = Heartbeat;
