const { checkLogin } = require("../util-server");
const { UptimeCalculator } = require("../uptime-calculator");
const { log } = require("../../src/util");
const { z } = require("zod");
const { validate } = require("../validation");
const { requireResource } = require("../security/authz");
const { teamIdLoader } = require("../security/team-id-loaders");

const monitorIDSchema = z.number().int().positive();
// Bounded to a year in hours (8760) so the frontend's existing period
// options (recent/3h/6h/24h/1w, i.e. up to 168) are never rejected.
const periodSchema = z.number().int().min(0).max(8760);

module.exports.chartSocketHandler = (socket) => {
    socket.on("getMonitorChartData", async (monitorID, period, callback) => {
        try {
            checkLogin(socket);

            log.debug("monitor", `Get Monitor Chart Data: ${monitorID} User ID: ${socket.userID}`);

            if (period == null) {
                throw new Error("Invalid period.");
            }

            monitorID = validate(monitorIDSchema, monitorID);
            period = validate(periodSchema, period);

            await requireResource(socket.actor, "monitor:read", "monitor", monitorID, teamIdLoader);

            let uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);

            let data;
            if (period <= 24) {
                data = uptimeCalculator.getDataArray(period * 60, "minute");
            } else if (period <= 720) {
                data = uptimeCalculator.getDataArray(period, "hour");
            } else {
                data = uptimeCalculator.getDataArray(period / 24, "day");
            }

            callback({
                ok: true,
                data,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
