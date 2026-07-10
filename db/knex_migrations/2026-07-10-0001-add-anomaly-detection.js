/**
 * Migration: anomaly detection schema (ADR-0013, TASK-A1-1).
 *
 * Additive and dark by construction -- no existing behavior changes from this
 * migration alone. `monitor.anomaly_enabled` defaults to `false` (the
 * dark-launch gate: no monitor evaluates anomalies until it explicitly opts
 * in), and `alert_event` starts empty on every install. The anomaly detector
 * (Phase 1, TASK-A1-2) and its wiring into `beat()` (TASK-A1-3) are separate
 * tasks -- this migration only lays down the schema they will read/write.
 *
 * `alert_event.severity` is copied from `monitor.anomaly_severity` at event
 * time (not looked up live) so historical events keep the severity they were
 * raised with even if the monitor's setting later changes -- it must be one
 * of `SEVERITY_ORDER` from `server/notification-routing.js`
 * (`info`/`warning`/`critical`), matching `monitor.alert_severity` (ADR-0014)
 * so both feed the same `context.severity` used by
 * `Monitor.getRoutedNotificationList()`.
 */

/**
 * Apply the anomaly_* columns on monitor and create the alert_event table.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasColumn("monitor", "anomaly_enabled"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .boolean("anomaly_enabled")
                .notNullable()
                .defaultTo(false)
                .comment("Dark-launch gate for anomaly detection (ADR-0013). false = zero behavior change.");
        });
    }

    if (!(await knex.schema.hasColumn("monitor", "anomaly_metric"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .string("anomaly_metric", 20)
                .notNullable()
                .defaultTo("response_time")
                .comment("Metric evaluated for anomalies. v1 only supports response_time.");
        });
    }

    if (!(await knex.schema.hasColumn("monitor", "anomaly_window"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .integer("anomaly_window")
                .unsigned()
                .notNullable()
                .defaultTo(20)
                .comment("Number of historical minute-buckets compared against for the moving-average baseline.");
        });
    }

    if (!(await knex.schema.hasColumn("monitor", "anomaly_z_threshold"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .float("anomaly_z_threshold")
                .notNullable()
                .defaultTo(3.0)
                .comment("Standard-deviation threshold (z-score) that triggers an anomaly event.");
        });
    }

    if (!(await knex.schema.hasColumn("monitor", "anomaly_seasonality"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .string("anomaly_seasonality", 20)
                .notNullable()
                .defaultTo("none")
                .comment("none|hourly|daily|weekly -- v1 only implements none (Phase 2 is future work).");
        });
    }

    if (!(await knex.schema.hasColumn("monitor", "anomaly_direction"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .string("anomaly_direction", 10)
                .notNullable()
                .defaultTo("both")
                .comment("above|below|both -- which deviations from baseline count as anomalous.");
        });
    }

    if (!(await knex.schema.hasColumn("monitor", "anomaly_severity"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .string("anomaly_severity", 20)
                .notNullable()
                .defaultTo("warning")
                .comment("info|warning|critical (SEVERITY_ORDER) -- severity used for anomaly alert_event rows.");
        });
    }

    if (!(await knex.schema.hasTable("alert_event"))) {
        await knex.schema.createTable("alert_event", (table) => {
            table.increments("id");
            table
                .integer("monitor_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("monitor")
                .onDelete("CASCADE");
            table.string("type", 20).notNullable().comment("Alert type. v1 always 'anomaly'.");
            table.float("value").notNullable().comment("Observed value that triggered the event.");
            table.float("expected").notNullable().comment("Baseline/predicted value computed by the detector.");
            table.float("score").notNullable().comment("Anomaly score (e.g. z-score).");
            table
                .string("severity", 20)
                .notNullable()
                .comment("Copied from monitor.anomaly_severity at event time.");
            table.datetime("time").notNullable().defaultTo(knex.fn.now());
            table.index("monitor_id");
            table.index(["monitor_id", "time"]);
        });
    }
};

/**
 * Revert: drop alert_event and the anomaly_* columns, in reverse order.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
    if (await knex.schema.hasTable("alert_event")) {
        await knex.schema.dropTable("alert_event");
    }

    if (await knex.schema.hasColumn("monitor", "anomaly_severity")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("anomaly_severity");
        });
    }

    if (await knex.schema.hasColumn("monitor", "anomaly_direction")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("anomaly_direction");
        });
    }

    if (await knex.schema.hasColumn("monitor", "anomaly_seasonality")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("anomaly_seasonality");
        });
    }

    if (await knex.schema.hasColumn("monitor", "anomaly_z_threshold")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("anomaly_z_threshold");
        });
    }

    if (await knex.schema.hasColumn("monitor", "anomaly_window")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("anomaly_window");
        });
    }

    if (await knex.schema.hasColumn("monitor", "anomaly_metric")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("anomaly_metric");
        });
    }

    if (await knex.schema.hasColumn("monitor", "anomaly_enabled")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("anomaly_enabled");
        });
    }
};
