/**
 * Migration: Loki log monitoring (ADR-0019).
 *
 * Additive and dark by construction -- no existing behavior changes from this
 * migration alone. `monitor_log_rule` starts empty on every install (a `loki`
 * monitor with zero rules just checks reachability, same as any other pull
 * monitor with no conditions configured), and `monitor.loki_reachability_query`
 * defaults to null (empty = fall back to `GET /ready`).
 *
 * `monitor_log_rule.team_id` follows the team_id idiom established by
 * ADR-0014's `notification_route` migration (nullable, indexed, FK RESTRICT to
 * team) rather than inventing a second multi-tenancy pattern -- it is a
 * first-class RBAC-scoped resource (create/update/delete gated per team), not
 * a JSON blob on `monitor`, because each rule needs its own FK identity for
 * `alert_event.log_rule_id` traceability.
 *
 * `alert_event.log_rule_id` is nullable and ON DELETE SET NULL (not CASCADE)
 * so historical alert events survive a rule being edited/deleted later --
 * mirrors how `alert_event.severity` (ADR-0013) is copied at event time
 * rather than looked up live.
 */

/**
 * Apply monitor.loki_reachability_query, the monitor_log_rule table, and
 * alert_event.log_rule_id.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasColumn("monitor", "loki_reachability_query"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .string("loki_reachability_query", 500)
                .nullable()
                .comment("Optional lightweight LogQL used only to decide heartbeat UP/DOWN; empty = GET /ready.");
        });
    }

    if (!(await knex.schema.hasTable("monitor_log_rule"))) {
        await knex.schema.createTable("monitor_log_rule", (table) => {
            table.increments("id");
            table
                .integer("monitor_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("monitor")
                .onDelete("CASCADE");
            table
                .integer("team_id")
                .unsigned()
                .nullable()
                .index()
                .references("id")
                .inTable("team")
                .onDelete("RESTRICT");
            table.string("name", 100).notNullable();
            table
                .text("logql")
                .notNullable()
                .comment('Full LogQL expression, e.g. count_over_time({job="app"} |= "error" [5m])');
            table
                .string("operator", 10)
                .notNullable()
                .comment(">|>=|<|<=|==|!= -- same vocabulary as evaluateJsonQuery");
            table.float("threshold").notNullable();
            table
                .string("severity", 20)
                .notNullable()
                .defaultTo("warning")
                .comment("info|warning|critical (SEVERITY_ORDER)");
            table.boolean("enabled").notNullable().defaultTo(true);
            table.integer("sort_order").unsigned().notNullable().defaultTo(0);
            table.datetime("created_date").defaultTo(knex.fn.now());
            table.index("monitor_id");
            table.index(["monitor_id", "enabled"]);
        });
    }

    if (!(await knex.schema.hasColumn("alert_event", "log_rule_id"))) {
        await knex.schema.alterTable("alert_event", (table) => {
            table
                .integer("log_rule_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("monitor_log_rule")
                .onDelete("SET NULL")
                .comment("Set when alert_event.type = 'log_rule'; the rule that fired.");
        });
    }
};

/**
 * Revert: drop alert_event.log_rule_id, monitor_log_rule, and
 * monitor.loki_reachability_query, in reverse order.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
    if (await knex.schema.hasColumn("alert_event", "log_rule_id")) {
        await knex.schema.alterTable("alert_event", (table) => {
            table.dropColumn("log_rule_id");
        });
    }

    if (await knex.schema.hasTable("monitor_log_rule")) {
        await knex.schema.dropTable("monitor_log_rule");
    }

    if (await knex.schema.hasColumn("monitor", "loki_reachability_query")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("loki_reachability_query");
        });
    }
};
