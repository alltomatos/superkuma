const KumaColumnCompiler = require("../utils/knex/lib/dialects/mysql2/schema/mysql2-columncompiler");

/**
 * Patch the "mysql2" knex client's column compiler.
 * Workaround: Tried extending the ColumnCompiler class, but it didn't work for unknown reasons, so I override the function via prototype
 * @returns {void}
 */
function patchMysql2ColumnCompiler() {
    const { getDialectByNameOrAlias } = require("knex/lib/dialects");
    const mysql2 = getDialectByNameOrAlias("mysql2");
    mysql2.prototype.columnCompiler = function () {
        return new KumaColumnCompiler(this, ...arguments);
    };
}

module.exports = {
    patchMysql2ColumnCompiler,
};
