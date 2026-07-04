exports.up = function (knex) {
    return knex.schema
        .createTable("remote_instance", function (table) {
            table.increments("id");
            table.comment("A registered remote SuperKuma agent instance in a Master-Agent federation setup");
            table.string("instance_id", 255).notNullable().unique().comment("Unique identifier the agent presents to the master");
            table.string("name", 255).notNullable().comment("Human-readable label for this instance");
            table.string("token_hash", 255).notNullable().comment("Hashed auth token (bcrypt, same convention as api_key)");
            table.datetime("last_seen").nullable().defaultTo(null);
            table.boolean("active").notNullable().defaultTo(true);
            table.integer("user_id").unsigned().references("id").inTable("user").onDelete("CASCADE").onUpdate("CASCADE");
        })
        .alterTable("monitor", function (table) {
            // Add new column monitor.remote_instance_id
            table
                .integer("remote_instance_id")
                .nullable()
                .defaultTo(null)
                .unsigned()
                .index()
                .references("id")
                .inTable("remote_instance")
                .onDelete("SET NULL");
        });
};

exports.down = function (knex) {
    return knex.schema
        .alterTable("monitor", function (table) {
            table.dropColumn("remote_instance_id");
        })
        .dropTable("remote_instance");
};
