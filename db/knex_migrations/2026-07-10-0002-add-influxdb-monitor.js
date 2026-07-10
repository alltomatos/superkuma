exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table
            .string("influxdb_database")
            .defaultTo(null)
            .comment("InfluxDB v1 database name (the `db` query param) for influxdb metric monitors");
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("influxdb_database");
    });
};
