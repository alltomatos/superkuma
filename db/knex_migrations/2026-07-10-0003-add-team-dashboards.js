/**
 * Migration: team dashboards (ADR-0016).
 *
 * `dashboard` is always team-scoped (never global, never public -- no
 * `is_public` column exists here, unlike `status_page`). `dashboard_widget`
 * is an ordered list of monitor references with a widget kind and an
 * optional section heading (mirrors `status_page`'s groups ergonomics
 * without a separate sections table).
 *
 * `ON DELETE CASCADE` on `dashboard.team_id` is a deliberate departure from
 * the `RESTRICT` convention used for `monitor.team_id`/`notification_route.team_id`
 * (ADR-0010, ADR-0014): a dashboard carries no history worth protecting, it is
 * only a saved composition -- losing it when its team is deleted is expected,
 * not a data-loss risk. Same reasoning for `dashboard_widget`'s FKs.
 *
 * Also re-runs `seedPermissionsAndRoles()` (idempotent by construction, see
 * server/permissions/seed.js) so the two new `dashboard:read`/`dashboard:manage`
 * catalog entries actually get their `permission` + `role_permission` rows on an
 * already-migrated database -- the original RBAC migration only seeds once, at
 * the time it runs, so a later catalog.js addition needs a fresh call to
 * converge. `down()` deliberately does not unseed these rows (no unseed
 * function exists, and orphaned catalog rows for a removed feature are
 * harmless -- nothing reads them once the code path is gone).
 */

const { seedPermissionsAndRoles } = require("../../server/permissions/seed");

/**
 * Apply the dashboard and dashboard_widget tables.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasTable("dashboard"))) {
        await knex.schema.createTable("dashboard", (table) => {
            table.increments("id");
            table
                .integer("team_id")
                .unsigned()
                .notNullable()
                .index()
                .references("id")
                .inTable("team")
                .onDelete("CASCADE");
            table.string("title", 255).notNullable();
            table.datetime("created_date").defaultTo(knex.fn.now());
            table.unique(["team_id", "title"]);
        });
    }

    if (!(await knex.schema.hasTable("dashboard_widget"))) {
        await knex.schema.createTable("dashboard_widget", (table) => {
            table.increments("id");
            table
                .integer("dashboard_id")
                .unsigned()
                .notNullable()
                .index()
                .references("id")
                .inTable("dashboard")
                .onDelete("CASCADE");
            table
                .integer("monitor_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("monitor")
                .onDelete("CASCADE");
            table
                .string("kind", 20)
                .notNullable()
                .defaultTo("status_tile")
                .comment("status_tile | metric_gauge | group_summary (v1, app-level enum, see ADR-0016)");
            table.string("section_name", 255).nullable();
            table.integer("sort_order").notNullable().defaultTo(0);
        });
    }

    await seedPermissionsAndRoles(knex);
};

/**
 * Revert: drop dashboard_widget then dashboard.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
    if (await knex.schema.hasTable("dashboard_widget")) {
        await knex.schema.dropTable("dashboard_widget");
    }

    if (await knex.schema.hasTable("dashboard")) {
        await knex.schema.dropTable("dashboard");
    }
};
