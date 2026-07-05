exports.up = function (knex) {
    return knex.schema.createTable("stat_monthly", function (table) {
        table.increments("id");
        table.comment(
            "This table contains the monthly aggregate statistics for each monitor (long-term retention tier)"
        );
        table
            .integer("monitor_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("monitor")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");
        table.integer("timestamp").notNullable().comment("Unix timestamp rounded down to the start of the month (UTC)");
        table.float("ping", 20, 2).notNullable().defaultTo(0).comment("Average ping in milliseconds");
        table
            .float("ping_min", 20, 2)
            .notNullable()
            .defaultTo(0)
            .comment("Minimum ping during this period in milliseconds");
        table
            .float("ping_max", 20, 2)
            .notNullable()
            .defaultTo(0)
            .comment("Maximum ping during this period in milliseconds");
        table.smallint("up").notNullable();
        table.smallint("down").notNullable();
        table.text("extras").defaultTo(null).comment("Extra statistics during this time period");

        table.unique(["monitor_id", "timestamp"]);
    });
};

exports.down = function (knex) {
    return knex.schema.dropTable("stat_monthly");
};
