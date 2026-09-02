/**
 * Migration: warning threshold for metric monitors (ADR-0014 extension).
 *
 * Additive and dark by construction -- no existing behavior changes from this
 * migration alone. `monitor.warning_value` defaults to `null` ("no warning
 * band configured"), the same not-yet-opted-in convention as
 * `monitor.anomaly_enabled` (ADR-0013). `Monitor.evaluateWarningThreshold()`
 * is a no-op whenever it is null, so every existing install stays
 * byte-identical to today's plain UP/DOWN behavior until a value is set.
 *
 * Lets a metric monitor (prometheus/influxdb/snmp/json-query -- anything
 * whose heartbeat carries an extractable numeric value, see
 * `Heartbeat.METRIC_MONITOR_TYPES`) alert at two thresholds instead of one:
 * `expectedValue`/`jsonPathOperator` stays the existing DOWN ("critical")
 * condition, `warning_value` is evaluated with the same operator to detect
 * an in-between "Alerta" band that notifies via `notification_route`
 * (severity `warning`) without ever flipping the monitor's UP/DOWN status --
 * mirrors how `alert_event` already decouples anomaly notifications from
 * up/down accounting.
 */

/**
 * Apply the warning_value column.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasColumn("monitor", "warning_value"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .float("warning_value")
                .nullable()
                .defaultTo(null)
                .comment(
                    "Optional 'Alerta' threshold for metric monitors, evaluated with the same jsonPathOperator as expectedValue. Null = warning band disabled."
                );
        });
    }
};

/**
 * Revert: drop warning_value.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
    if (await knex.schema.hasColumn("monitor", "warning_value")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("warning_value");
        });
    }
};
