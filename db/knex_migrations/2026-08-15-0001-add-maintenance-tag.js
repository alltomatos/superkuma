/**
 * Migration: allow a Maintenance window to target a tag, not just individually
 * picked monitors. Membership is resolved live (via monitor_tag) at check
 * time in Monitor.isUnderMaintenance(), not materialized -- a monitor tagged
 * after the maintenance window was created is covered automatically, and one
 * untagged later drops out automatically. Mirrors the existing
 * maintenance_status_page join table.
 */

/**
 * Create the maintenance_tag table.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasTable("maintenance_tag"))) {
        await knex.schema.createTable("maintenance_tag", (table) => {
            table.increments("id");

            table
                .integer("maintenance_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("maintenance")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            table
                .integer("tag_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("tag")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            table.index(["maintenance_id", "tag_id"], "maintenance_tag_index");
        });
    }
};

/**
 * Drop the maintenance_tag table.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
    if (await knex.schema.hasTable("maintenance_tag")) {
        await knex.schema.dropTable("maintenance_tag");
    }
};
