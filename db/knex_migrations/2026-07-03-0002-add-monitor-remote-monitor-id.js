exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table
            .string("remote_monitor_id", 255)
            .nullable()
            .defaultTo(null)
            .comment(
                "The agent's own identifier for this monitor, used together with remote_instance_id to find/upsert the mirrored monitor"
            );
        table.unique(["remote_instance_id", "remote_monitor_id"]);
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropUnique(["remote_instance_id", "remote_monitor_id"]);
        table.dropColumn("remote_monitor_id");
    });
};
