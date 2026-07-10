/**
 * Migration: alert severity + notification routing (ADR-0014, TASK-A0-1).
 *
 * Additive and dark by construction -- no existing behavior changes from this
 * migration alone. `monitor.alert_severity` defaults to "critical" (today's
 * implicit reality: every DOWN is treated as grave), and `notification_route`
 * starts empty on every install, so `resolveNotificationTargets()` (TASK-A0-2)
 * falls back to the exact legacy `getNotificationList()` result until a route
 * is actually created. Follows the team_id idiom established by the RBAC
 * migration (nullable, indexed, FK RESTRICT to team) rather than inventing a
 * second multi-tenancy pattern.
 */

/**
 * Apply the alert_severity column and notification_route table.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasColumn("monitor", "alert_severity"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .string("alert_severity", 20)
                .notNullable()
                .defaultTo("critical")
                .comment("critical|warning|info -- selector for notification_route matching (ADR-0014)");
        });
    }

    if (!(await knex.schema.hasTable("notification_route"))) {
        await knex.schema.createTable("notification_route", (table) => {
            table.increments("id");
            table
                .integer("team_id")
                .unsigned()
                .nullable()
                .index()
                .references("id")
                .inTable("team")
                .onDelete("RESTRICT");
            table.string("min_severity", 20).notNullable().defaultTo("critical");
            table
                .integer("monitor_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("monitor")
                .onDelete("CASCADE");
            table.integer("tag_id").unsigned().nullable().references("id").inTable("tag").onDelete("CASCADE");
            table
                .integer("notification_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("notification")
                .onDelete("CASCADE");
            table.datetime("created_date").defaultTo(knex.fn.now());
            table.index(["team_id", "min_severity"]);
        });
    }
};

/**
 * Revert: drop notification_route and the alert_severity column.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
    if (await knex.schema.hasTable("notification_route")) {
        await knex.schema.dropTable("notification_route");
    }

    if (await knex.schema.hasColumn("monitor", "alert_severity")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("alert_severity");
        });
    }
};
