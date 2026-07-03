const { R } = require("redbean-node");
const { log } = require("../../src/util");
const tls = require("tls");
const crypto = require("crypto");
const { Settings } = require("../settings");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));

// ssl-checker by @dyaa
//https://github.com/dyaa/ssl-checker/blob/master/src/index.ts

/**
 * Get number of days between two dates
 * @param {Date} validFrom Start date
 * @param {Date} validTo End date
 * @returns {number} Number of days
 */
const getDaysBetween = (validFrom, validTo) => Math.round(Math.abs(+validFrom - +validTo) / 8.64e7);

/**
 * Get days remaining from a time range
 * @param {Date} validFrom Start date
 * @param {Date} validTo End date
 * @returns {number} Number of days remaining
 */
const getDaysRemaining = (validFrom, validTo) => {
    const daysRemaining = getDaysBetween(validFrom, validTo);
    if (new Date(validTo).getTime() < new Date().getTime()) {
        return -daysRemaining;
    }
    return daysRemaining;
};
module.exports.getDaysRemaining = getDaysRemaining;

/**
 * Fix certificate info for display
 * @param {object} info The chain obtained from getPeerCertificate()
 * @returns {object} An object representing certificate information
 * @throws The certificate chain length exceeded 500.
 */
const parseCertificateInfo = function (info) {
    let link = info;
    let i = 0;

    const existingList = {};

    while (link) {
        log.debug("cert", `[${i}] ${link.fingerprint}`);

        if (!link.valid_from || !link.valid_to) {
            break;
        }
        link.validTo = new Date(link.valid_to);
        link.validFor = link.subjectaltname?.replace(/DNS:|IP Address:/g, "").split(", ");
        link.daysRemaining = dayjs.utc(link.validTo).diff(dayjs.utc(), "day");

        existingList[link.fingerprint] = true;

        // Move up the chain until loop is encountered
        if (link.issuerCertificate == null) {
            link.certType = i === 0 ? "self-signed" : "root CA";
            break;
        } else if (link.issuerCertificate.fingerprint in existingList) {
            // a root CA certificate is typically "signed by itself"  (=> "self signed certificate") and thus the "issuerCertificate" is a reference to itself.
            log.debug("cert", `[Last] ${link.issuerCertificate.fingerprint}`);
            link.certType = i === 0 ? "self-signed" : "root CA";
            link.issuerCertificate = null;
            break;
        } else {
            link.certType = i === 0 ? "server" : "intermediate CA";
            link = link.issuerCertificate;
        }

        // Should be no use, but just in case.
        if (i > 500) {
            throw new Error("Dead loop occurred in parseCertificateInfo");
        }
        i++;
    }

    return info;
};

/**
 * Check if certificate is valid
 * @param {tls.TLSSocket} socket TLSSocket, which may or may not be connected
 * @returns {null | {valid: boolean, certInfo: object}} Object containing certificate information
 */
exports.checkCertificate = function (socket) {
    let certInfoStartTime = dayjs().valueOf();

    // Return null if there is no socket
    if (socket === undefined || socket == null) {
        return null;
    }

    const info = socket.getPeerCertificate(true);
    const valid = socket.authorized || false;

    log.debug("cert", "Parsing Certificate Info");
    const parsedInfo = parseCertificateInfo(info);

    if (process.env.TIMELOGGER === "1") {
        log.debug("monitor", "Cert Info Query Time: " + (dayjs().valueOf() - certInfoStartTime) + "ms");
    }

    return {
        valid: valid,
        certInfo: parsedInfo,
    };
};

/**
 * Checks if the certificate is valid for the provided hostname.
 * Defaults to true if feature `X509Certificate` is not available, or input is not valid.
 * @param {Buffer} certBuffer - The certificate buffer.
 * @param {string} hostname - The hostname to compare against.
 * @returns {boolean} True if the certificate is valid for the provided hostname, false otherwise.
 */
exports.checkCertificateHostname = function (certBuffer, hostname) {
    let X509Certificate;
    try {
        X509Certificate = require("node:crypto").X509Certificate;
    } catch (_) {
        // X509Certificate is not available in this version of Node.js
        return true;
    }

    if (!X509Certificate || !certBuffer || !hostname) {
        return true;
    }

    let certObject = new X509Certificate(certBuffer);
    return certObject.checkHost(hostname) !== undefined;
};

/**
 * Returns an array of SHA256 fingerprints for all known root certificates.
 * @returns {Set} A set of SHA256 fingerprints.
 */
module.exports.rootCertificatesFingerprints = () => {
    let fingerprints = tls.rootCertificates.map((cert) => {
        let certLines = cert.split("\n");
        certLines.shift();
        certLines.pop();
        let certBody = certLines.join("");
        let buf = Buffer.from(certBody, "base64");

        const shasum = crypto.createHash("sha256");
        shasum.update(buf);

        return shasum
            .digest("hex")
            .toUpperCase()
            .replace(/(.{2})(?!$)/g, "$1:");
    });

    fingerprints.push(
        "6D:99:FB:26:5E:B1:C5:B3:74:47:65:FC:BC:64:8F:3C:D8:E1:BF:FA:FD:C4:C2:F9:9B:9D:47:CF:7F:F1:C2:4F"
    ); // ISRG X1 cross-signed with DST X3
    fingerprints.push(
        "8B:05:B6:8C:C6:59:E5:ED:0F:CB:38:F2:C9:42:FB:FD:20:0E:6F:2F:F9:F8:5D:63:C6:99:4E:F5:E0:B0:27:01"
    ); // ISRG X2 cross-signed with ISRG X1

    return new Set(fingerprints);
};

/**
 * checks certificate chain for expiring certificates
 * @param {object} monitor - The monitor object
 * @param {object} tlsInfoObject Information about certificate
 * @returns {Promise<void>}
 */
async function checkCertExpiryNotifications(monitor, tlsInfoObject) {
    if (!tlsInfoObject || !tlsInfoObject.certInfo || !tlsInfoObject.certInfo.daysRemaining) {
        return;
    }

    let notificationList = await R.getAll(
        "SELECT notification.* FROM notification, monitor_notification WHERE monitor_id = ? AND monitor_notification.notification_id = notification.id ",
        [monitor.id]
    );

    if (!notificationList.length > 0) {
        // fail fast. If no notification is set, all the following checks can be skipped.
        log.debug("monitor", "No notification, no need to send cert notification");
        return;
    }

    let notifyDays = await Settings.get("tlsExpiryNotifyDays");
    if (notifyDays == null || !Array.isArray(notifyDays)) {
        // Reset Default
        await Settings.set("tlsExpiryNotifyDays", [7, 14, 21], "general");
        notifyDays = [7, 14, 21];
    }

    for (const targetDays of notifyDays) {
        let certInfo = tlsInfoObject.certInfo;
        while (certInfo) {
            let subjectCN = certInfo.subject["CN"];
            if (monitor.rootCertificates.has(certInfo.fingerprint256)) {
                log.debug(
                    "monitor",
                    `Known root cert: ${certInfo.certType} certificate "${subjectCN}" (${certInfo.daysRemaining} days valid) on ${targetDays} deadline.`
                );
                break;
            } else if (certInfo.daysRemaining > targetDays) {
                log.debug(
                    "monitor",
                    `No need to send cert notification for ${certInfo.certType} certificate "${subjectCN}" (${certInfo.daysRemaining} days valid) on ${targetDays} deadline.`
                );
            } else {
                log.debug(
                    "monitor",
                    `call sendCertNotificationByTargetDays for ${targetDays} deadline on certificate ${subjectCN}.`
                );
                await monitor.sendCertNotificationByTargetDays(
                    subjectCN,
                    certInfo.certType,
                    certInfo.daysRemaining,
                    targetDays,
                    notificationList
                );
            }
            certInfo = certInfo.issuerCertificate;
        }
    }
}
module.exports.checkCertExpiryNotifications = checkCertExpiryNotifications;

// For unit test, export functions
if (process.env.TEST_BACKEND) {
    module.exports.__test = {
        parseCertificateInfo,
    };
}
