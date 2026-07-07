exports.up = function (knex) {
    return knex.schema.alterTable("user", function (table) {
        table.string("email", 255).nullable().defaultTo(null).comment("Used to send the welcome email on creation");
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("user", function (table) {
        table.dropColumn("email");
    });
};
