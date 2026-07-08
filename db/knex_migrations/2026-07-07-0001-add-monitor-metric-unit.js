exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table
            .string("metric_unit", 20)
            .defaultTo(null)
            .comment("Display unit for prometheus metric monitors (e.g. %, GB, MB, s) — presentation only");
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("metric_unit");
    });
};
