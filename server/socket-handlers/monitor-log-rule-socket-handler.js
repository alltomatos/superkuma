const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const { requireResource } = require("../security/authz");
const { teamIdLoader } = require("../security/team-id-loaders");
const { SEVERITY_ORDER } = require("../notification-routing");
const { z } = require("zod");
const { validate } = require("../validation");

const OPERATORS = [">", ">=", "<", "<=", "==", "!="];

const createRuleSchema = z.object({
    monitorId: z.number().int().positive(),
    name: z.string().trim().min(1).max(100),
    logql: z.string().trim().min(1),
    operator: z.enum(OPERATORS),
    threshold: z.number(),
    severity: z.enum(SEVERITY_ORDER),
    enabled: z.boolean().optional(),
});

const updateRuleSchema = z.object({
    id: z.number().int().positive(),
    name: z.string().trim().min(1).max(100),
    logql: z.string().trim().min(1),
    operator: z.enum(OPERATORS),
    threshold: z.number(),
    severity: z.enum(SEVERITY_ORDER),
    enabled: z.boolean(),
});

const ruleIdSchema = z.number().int().positive();
const monitorIdSchema = z.number().int().positive();

/**
 * Handlers for `monitor_log_rule` (ADR-0019): the LogQL patterns/thresholds a
 * `loki`-type monitor evaluates on every check, independent of its own
 * reachability heartbeat. Gated by the same `monitor:read`/`monitor:update`
 * permissions used to view/edit the monitor itself -- a log rule is
 * conceptually part of a monitor's configuration, not a standalone resource
 * with its own permission grant, mirroring how monitor tags/notifications are
 * authorized today.
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.monitorLogRuleSocketHandler = (socket) => {
    socket.on("getLogRuleList", async (monitorId, callback) => {
        try {
            checkLogin(socket);
            monitorId = validate(monitorIdSchema, monitorId);

            await requireResource(socket.actor, "monitor:read", "monitor", monitorId, teamIdLoader);

            const rules = await R.find("monitor_log_rule", "monitor_id = ? ORDER BY sort_order ASC, id ASC", [
                monitorId,
            ]);

            callback({ ok: true, ruleList: rules.map((rule) => rule.export()) });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("addLogRule", async (input, callback) => {
        try {
            checkLogin(socket);
            const { monitorId, name, logql, operator, threshold, severity, enabled } = validate(
                createRuleSchema,
                input
            );

            await requireResource(socket.actor, "monitor:update", "monitor", monitorId, teamIdLoader);

            const monitor = await R.findOne("monitor", "id = ?", [monitorId]);
            if (!monitor) {
                throw new Error("Monitor not found.");
            }

            const rule = R.dispense("monitor_log_rule");
            rule.monitor_id = monitorId;
            rule.team_id = monitor.team_id;
            rule.name = name;
            rule.logql = logql;
            rule.operator = operator;
            rule.threshold = threshold;
            rule.severity = severity;
            rule.enabled = enabled ?? true;
            await R.store(rule);

            log.debug("monitor-log-rule", `Created log rule ${rule.id} for monitor ${monitorId}`);

            callback({ ok: true, msg: "successAdded", msgi18n: true, ruleId: rule.id });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("updateLogRule", async (input, callback) => {
        try {
            checkLogin(socket);
            const { id, name, logql, operator, threshold, severity, enabled } = validate(updateRuleSchema, input);

            await requireResource(socket.actor, "monitor:update", "monitor_log_rule", id, teamIdLoader);

            const rule = await R.findOne("monitor_log_rule", "id = ?", [id]);
            if (!rule) {
                throw new Error("Log rule not found.");
            }

            rule.name = name;
            rule.logql = logql;
            rule.operator = operator;
            rule.threshold = threshold;
            rule.severity = severity;
            rule.enabled = enabled;
            await R.store(rule);

            log.debug("monitor-log-rule", `Updated log rule ${id}`);

            callback({ ok: true, msg: "successEdited", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("deleteLogRule", async (id, callback) => {
        try {
            checkLogin(socket);
            id = validate(ruleIdSchema, id);

            await requireResource(socket.actor, "monitor:update", "monitor_log_rule", id, teamIdLoader);

            await R.exec("DELETE FROM monitor_log_rule WHERE id = ?", [id]);

            log.debug("monitor-log-rule", `Deleted log rule ${id}`);

            callback({ ok: true, msg: "successDeleted", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });
};
