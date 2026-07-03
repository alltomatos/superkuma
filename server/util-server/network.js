const ping = require("@louislam/ping");
const {
    log,
    PING_PACKET_SIZE_DEFAULT,
    PING_GLOBAL_TIMEOUT_DEFAULT,
    PING_COUNT_DEFAULT,
    PING_PER_REQUEST_TIMEOUT_DEFAULT,
} = require("../../src/util");
const { NtlmClient } = require("../modules/axios-ntlm/lib/ntlmClient.js");
const { networkInterfaces } = require("os");
const { isWindows } = require("./shared");
const { convertToUTF8 } = require("./format");

/**
 * Ping the specified machine
 * @param {string} destAddr Hostname / IP address of machine to ping
 * @param {number} count Number of packets to send before stopping
 * @param {string} sourceAddr Source address for sending/receiving echo requests
 * @param {boolean} numeric If true, IP addresses will be output instead of symbolic hostnames
 * @param {number} size Size (in bytes) of echo request to send
 * @param {number} deadline Maximum time in seconds before ping stops, regardless of packets sent
 * @param {number} timeout Maximum time in seconds to wait for each response
 * @returns {Promise<number>} Time for ping in ms rounded to nearest integer
 */
exports.ping = async (
    destAddr,
    count = PING_COUNT_DEFAULT,
    sourceAddr = "",
    numeric = true,
    size = PING_PACKET_SIZE_DEFAULT,
    deadline = PING_GLOBAL_TIMEOUT_DEFAULT,
    timeout = PING_PER_REQUEST_TIMEOUT_DEFAULT
) => {
    try {
        return await exports.pingAsync(destAddr, false, count, sourceAddr, numeric, size, deadline, timeout);
    } catch (e) {
        // If the host cannot be resolved, try again with ipv6
        log.debug("ping", "IPv6 error message: " + e.message);

        // As node-ping does not report a specific error for this, try again if it is an empty message with ipv6 no matter what.
        if (!e.message) {
            return await exports.pingAsync(destAddr, true, count, sourceAddr, numeric, size, deadline, timeout);
        } else {
            throw e;
        }
    }
};

/**
 * Ping the specified machine
 * @param {string} destAddr Hostname / IP address of machine to ping
 * @param {boolean} ipv6 Should IPv6 be used?
 * @param {number} count Number of packets to send before stopping
 * @param {string} sourceAddr Source address for sending/receiving echo requests
 * @param {boolean} numeric If true, IP addresses will be output instead of symbolic hostnames
 * @param {number} size Size (in bytes) of echo request to send
 * @param {number} deadline Maximum time in seconds before ping stops, regardless of packets sent
 * @param {number} timeout Maximum time in seconds to wait for each response
 * @returns {Promise<number>} Time for ping in ms rounded to nearest integer
 */
exports.pingAsync = function (
    destAddr,
    ipv6 = false,
    count = PING_COUNT_DEFAULT,
    sourceAddr = "",
    numeric = true,
    size = PING_PACKET_SIZE_DEFAULT,
    deadline = PING_GLOBAL_TIMEOUT_DEFAULT,
    timeout = PING_PER_REQUEST_TIMEOUT_DEFAULT
) {
    try {
        const url = new URL(`http://${destAddr}`);
        destAddr = url.hostname;
        if (destAddr.startsWith("[") && destAddr.endsWith("]")) {
            destAddr = destAddr.slice(1, -1);
        }
    } catch (e) {
        // ignore
    }

    return new Promise((resolve, reject) => {
        ping.promise
            .probe(destAddr, {
                v6: ipv6,
                min_reply: count,
                sourceAddr: sourceAddr,
                numeric: numeric,
                packetSize: size,
                deadline: deadline,
                timeout: timeout,
            })
            .then((res) => {
                // If ping failed, it will set field to unknown
                if (res.alive) {
                    resolve(res.time);
                } else {
                    if (isWindows) {
                        reject(new Error(convertToUTF8(res.output)));
                    } else {
                        reject(new Error(res.output));
                    }
                }
            })
            .catch((err) => {
                reject(err);
            });
    });
};

/**
 * Use NTLM Auth for a http request.
 * @param {object} options The http request options
 * @param {object} ntlmOptions The auth options
 * @returns {Promise<(string[] | object[] | object)>} NTLM response
 */
exports.httpNtlm = function (options, ntlmOptions) {
    return new Promise((resolve, reject) => {
        let client = NtlmClient(ntlmOptions);

        client(options)
            .then((resp) => {
                resolve(resp);
            })
            .catch((err) => {
                reject(err);
            });
    });
};

/**
 * Log the server's listening URLs, similar to Vite's dev server output.
 * When no hostname is specified (bound to all interfaces), it prints
 * localhost plus every non-internal network address.
 * @param {string} tag Log tag (e.g. "server", "setup-database")
 * @param {number} port Port number
 * @param {string} hostname Bound hostname, if any
 * @param {boolean} isHTTPS Whether the server is using HTTPS
 * @returns {void}
 */
module.exports.printServerUrls = (tag, port, hostname, isHTTPS = false) => {
    try {
        // If hostname is specified, just print that one.
        if (hostname) {
            log.info(tag, `Listening on: `, createURL(isHTTPS, hostname, port));
            return;
        }

        // Since no hostname is specified, which means the server is bound to all interfaces, we need to print all possible URLs.
        const nets = networkInterfaces();

        log.info(tag, "Listening on:");
        log.info(tag, `- `, createURL(isHTTPS, "localhost", port));

        // Prepare a list of valid address
        const addressList = [];
        for (const iface of Object.values(nets)) {
            for (const addr of iface) {
                if (!addr.internal) {
                    addressList.push(addr);
                }
            }
        }

        // Sort IPv4 addresses first
        addressList.sort((a, b) => {
            if (a.family === "IPv4" && b.family === "IPv6") {
                return -1;
            } else if (a.family === "IPv6" && b.family === "IPv4") {
                return 1;
            } else {
                return a.address.localeCompare(b.address);
            }
        });

        for (const address of addressList) {
            if (!address.internal) {
                const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
                log.info(tag, `- `, createURL(isHTTPS, host, port));
            }
        }
    } catch (e) {
        log.error(tag, "Error printing server URLs: " + e.message);
    }
};

/**
 * Construct a URL a bit more safely
 * @param {boolean} isHTTPS Whether the URL should use HTTPS protocol
 * @param {string} hostname The hostname to use in the URL
 * @param {number} port The port
 * @returns {string} The constructed URL as a string
 */
function createURL(isHTTPS, hostname, port = 80) {
    const url = new URL((isHTTPS ? "https" : "http") + `://` + hostname);
    url.port = String(port);

    // Prefer origin if available, it doesn't contain the trailing slash
    return url.origin || url.toString();
}
