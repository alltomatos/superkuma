// monitor.radius_password was reused as a generic secret field by 3 monitor
// types (radius, snmp community string, mysql password), not just RADIUS.
// Renamed to the generic `password` to match actual usage; renameColumn
// preserves existing data for all engines (SQLite/MariaDB/MySQL/Postgres).
exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.renameColumn("radius_password", "password");
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.renameColumn("password", "radius_password");
    });
};
