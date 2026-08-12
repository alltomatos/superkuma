exports.up = function (knex) {
    // Add wallboard/TV-mode columns to status_page: rotate through groups one
    // at a time instead of showing everything at once, and audible/toast
    // alerting when a monitor goes down while the page is open.
    return knex.schema.alterTable("status_page", function (table) {
        table.boolean("tab_rotation_enabled").notNullable().defaultTo(false);
        table.integer("tab_rotation_interval").notNullable().defaultTo(15);
        table.boolean("sound_alerts_enabled").notNullable().defaultTo(false);
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("status_page", function (table) {
        table.dropColumn("tab_rotation_enabled");
        table.dropColumn("tab_rotation_interval");
        table.dropColumn("sound_alerts_enabled");
    });
};
