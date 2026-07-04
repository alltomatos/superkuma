let express = require("express");
const { R } = require("redbean-node");
const Monitor = require("../model/monitor");
const dayjs = require("dayjs");
const { UP, DOWN, MAINTENANCE, flipStatus, log } = require("../../src/util");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { Prometheus } = require("../prometheus");
const { UptimeCalculator } = require("../uptime-calculator");
const { verifyRemoteInstanceToken } = require("../auth");
const { z } = require("zod");
const { validate } = require("../validation");

let router = express.Router();

const server = UptimeKumaServer.getInstance();
let io = server.io;

// Sensible defaults matching a regular push-type monitor created via the UI
// (see src/pages/EditMonitor.vue's default `monitor` object).
const DEFAULT_INTERVAL = 60;
const DEFAULT_RETRY_INTERVAL = 60;

const heartbeatSchema = z.object({
    agentMonitorId: z.string().trim().min(1).max(255),
    name: z.string().trim().min(1).max(255),
    type: z.string().trim().min(1).max(50),
    status: z.enum(["up", "down"]),
    msg: z.string().max(1000).optional().default(""),
    ping: z.number().finite().nullable().optional().default(null),
});

/**
 * Extract the bearer token from an Authorization header, if present
 * @param {express.Request} request Express request object
 * @returns {(string|null)} The token, or null if not present
 */
function extractToken(request) {
    const authHeader = request.headers["authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        return authHeader.substring("Bearer ".length).trim();
    }

    if (typeof request.body?.token === "string") {
        return request.body.token;
    }

    return null;
}

/**
 * Find the mirrored monitor for a remote instance + agent monitor id, or
 * create it if this is the first heartbeat seen for it.
 *
 * The mirrored monitor is ALWAYS type "push": the Master never actively
 * checks it, it only receives externally-driven heartbeats from the agent,
 * exactly matching how a regular push monitor already behaves. This reuses
 * the entire push-monitor pipeline downstream (UptimeCalculator,
 * notifications, socket emit) with zero special-casing.
 * @param {object} remoteInstance The authenticated remote_instance bean
 * @param {string} agentMonitorId The agent's own identifier for this monitor
 * @param {string} name Human-readable name reported by the agent
 * @returns {Promise<object>} The mirrored monitor bean
 */
async function findOrCreateMirroredMonitor(remoteInstance, agentMonitorId, name) {
    let monitor = await R.findOne("monitor", " remote_instance_id = ? AND remote_monitor_id = ? ", [
        remoteInstance.id,
        agentMonitorId,
    ]);

    if (monitor) {
        return monitor;
    }

    let bean = R.dispense("monitor");
    bean.name = `${name} (${remoteInstance.name})`;
    bean.type = "push";
    bean.remote_instance_id = remoteInstance.id;
    bean.remote_monitor_id = agentMonitorId;
    bean.user_id = remoteInstance.user_id;
    // ADR-0010 R7: without this, every mirrored monitor is born with
    // team_id=NULL -- a cross-tenant-invisible orphan created on every single
    // heartbeat from every agent, not just at migration time.
    bean.team_id = remoteInstance.team_id;
    bean.active = true;
    bean.interval = DEFAULT_INTERVAL;
    bean.retryInterval = DEFAULT_RETRY_INTERVAL;

    await R.store(bean);

    log.debug(
        "federation",
        `Created mirrored monitor ${bean.id} for remote instance ${remoteInstance.id} (agentMonitorId=${agentMonitorId})`
    );

    return bean;
}

router.post("/api/federation/heartbeat", async (request, response) => {
    try {
        const token = extractToken(request);
        const remoteInstance = await verifyRemoteInstanceToken(token);

        if (!remoteInstance) {
            response.status(401).json({
                ok: false,
                msg: "Invalid or inactive remote instance token.",
            });
            return;
        }

        const data = validate(heartbeatSchema, request.body);

        const monitor = await findOrCreateMirroredMonitor(remoteInstance, data.agentMonitorId, data.name);

        const statusFromAgent = data.status === "up" ? UP : DOWN;
        const ping = data.ping;
        const msg = data.msg;

        const previousHeartbeat = await Monitor.getPreviousHeartbeat(monitor.id);

        let isFirstBeat = true;

        let bean = R.dispense("heartbeat");
        bean.time = R.isoDateTimeMillis(dayjs.utc());
        bean.monitor_id = monitor.id;
        bean.ping = ping;
        bean.msg = msg;
        bean.downCount = previousHeartbeat?.downCount || 0;

        if (previousHeartbeat) {
            isFirstBeat = false;
            bean.duration = dayjs(bean.time).diff(dayjs(previousHeartbeat.time), "second");
        }

        if (await Monitor.isUnderMaintenance(monitor.id)) {
            bean.msg = "Monitor under maintenance";
            bean.status = MAINTENANCE;
        } else {
            // Federated monitors have no retry concept on the Master (retries,
            // if any, are the agent's own concern) -- report the status as-is,
            // flipped if the mirrored monitor is configured upside-down.
            bean.status = monitor.isUpsideDown() ? flipStatus(statusFromAgent) : statusFromAgent;
            bean.retries = 0;
        }

        // Calculate uptime
        let uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitor.id);
        let endTimeDayjs = await uptimeCalculator.update(bean.status, parseFloat(bean.ping));
        bean.end_time = R.isoDateTimeMillis(endTimeDayjs);

        log.debug("federation", `/api/federation/heartbeat called at ${dayjs().format("YYYY-MM-DD HH:mm:ss.SSS")}`);
        log.debug("federation", "PreviousStatus: " + previousHeartbeat?.status);
        log.debug("federation", "Current Status: " + bean.status);

        bean.important = Monitor.isImportantBeat(isFirstBeat, previousHeartbeat?.status, bean.status);

        if (Monitor.isImportantForNotification(isFirstBeat, previousHeartbeat?.status, bean.status)) {
            // Reset down count
            bean.downCount = 0;

            log.debug("federation", `[${monitor.name}] sendNotification`);
            await Monitor.sendNotification(isFirstBeat, monitor, bean);
        } else {
            if (bean.status === DOWN && monitor.resendInterval > 0) {
                ++bean.downCount;
                if (bean.downCount >= monitor.resendInterval) {
                    // Send notification again, because we are still DOWN
                    log.debug(
                        "federation",
                        `[${monitor.name}] sendNotification again: Down Count: ${bean.downCount} | Resend Interval: ${monitor.resendInterval}`
                    );
                    await Monitor.sendNotification(isFirstBeat, monitor, bean);

                    // Reset down count
                    bean.downCount = 0;
                }
            }
        }

        await R.store(bean);

        io.to(monitor.user_id).emit("heartbeat", bean.toJSON());

        Monitor.sendStats(io, monitor.id, monitor.user_id);

        try {
            new Prometheus(monitor, await monitor.getTags()).update(bean, undefined);
        } catch (e) {
            log.error("prometheus", "Please submit an issue to our GitHub repo. Prometheus update error: ", e.message);
        }

        // Keepalive signal for this remote instance (MVP; superseded by the
        // Socket.io-based keepalive planned for F4).
        await R.exec("UPDATE remote_instance SET last_seen = ? WHERE id = ? ", [
            R.isoDateTimeMillis(dayjs.utc()),
            remoteInstance.id,
        ]);

        response.json({
            ok: true,
        });
    } catch (e) {
        response.status(400).json({
            ok: false,
            msg: e.message,
        });
    }
});

module.exports = router;
