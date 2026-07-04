const axios = require("axios");
const { log, UP, DOWN } = require("../../src/util");
const { Settings } = require("../settings");

// Bounded so a slow/unreachable Master can never stall the local heartbeat
// pipeline for long -- see the try/catch below, which additionally guarantees
// this function never throws regardless of what happens on the wire.
const FORWARD_TIMEOUT_MS = 10000;

/**
 * Map an internal numeric heartbeat status to the string enum expected by
 * the Master's `/api/federation/heartbeat` endpoint.
 * @param {number} status Internal status constant (UP/DOWN/PENDING/MAINTENANCE)
 * @returns {(string|null)} "up"/"down", or null if this status is not (yet) forwarded
 */
function mapStatusForMaster(status) {
    if (status === UP) {
        return "up";
    }
    if (status === DOWN) {
        return "down";
    }
    // PENDING/MAINTENANCE are intentionally not forwarded in this MVP: the
    // Master's schema does not yet model them. Deferred to a later phase.
    return null;
}

/**
 * Forward a local monitor's heartbeat to a configured Master instance, for
 * the federation Agent role.
 *
 * This is a best-effort, fire-and-forget style operation with respect to the
 * caller: it never throws and never hangs beyond the configured timeout, so
 * it is always safe to `await` from the hot heartbeat path without any risk
 * of delaying or crashing local monitoring, even if the Master is slow,
 * unreachable, or misconfigured. When federation is not configured (the
 * common case for standalone users), it returns immediately and makes no
 * network call at all.
 * @param {import("./monitor")} monitor The local monitor that produced this heartbeat
 * @param {import("redbean-node").Bean} bean The heartbeat bean just persisted
 * @returns {Promise<void>} Resolves once the forward attempt (if any) has settled
 */
async function forwardHeartbeatToMaster(monitor, bean) {
    try {
        const masterUrl = await Settings.get("federationMasterUrl");
        const token = await Settings.get("federationToken");
        const instanceId = await Settings.get("federationInstanceId");

        if (!masterUrl || !token || !instanceId) {
            return;
        }

        const status = mapStatusForMaster(bean.status);
        if (status === null) {
            return;
        }

        await axios.post(
            `${masterUrl}/api/federation/heartbeat`,
            {
                agentMonitorId: monitor.id.toString(),
                name: monitor.name,
                type: monitor.type,
                status,
                msg: bean.msg,
                ping: bean.ping,
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                timeout: FORWARD_TIMEOUT_MS,
            }
        );
    } catch (e) {
        log.warn("federation", `Failed to forward heartbeat to Master: ${e.message}`);
    }
}

module.exports = {
    forwardHeartbeatToMaster,
};
