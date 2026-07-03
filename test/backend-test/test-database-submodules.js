const { describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const { initDataDir, getDevDataDir, getCurrentGitBranch } = require("../../server/database/paths");
const { patchList } = require("../../server/database/legacy-patches");
const { patchMysql2ColumnCompiler } = require("../../server/database/dialect");

describe("database/paths.js: getCurrentGitBranch()", () => {
    test("returns the actual current git branch name (this repo checkout)", () => {
        const expected = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
        const actual = getCurrentGitBranch();
        assert.strictEqual(actual, expected);
        assert.notStrictEqual(actual, "");
    });
});

describe("database/paths.js: getDevDataDir()", () => {
    test("returns empty string when not running in development mode", () => {
        // isDev is derived once from process.env.NODE_ENV at module-load time in src/util.js,
        // so under the test runner (NODE_ENV != development) this must be "".
        assert.strictEqual(getDevDataDir(), "");
    });
});

describe("database/paths.js: initDataDir()", () => {
    test("creates the data dir and all expected subdirectories, and sets Database static paths", (t) => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-test-initdatadir-"));
        t.after(() => {
            fs.rmSync(tmpBase, { recursive: true, force: true });
        });

        const dataDir = path.join(tmpBase, "my-data") + path.sep;
        const Database = {};

        initDataDir({ "data-dir": dataDir }, Database);

        assert.strictEqual(Database.dataDir, dataDir);
        assert.strictEqual(Database.sqlitePath, path.join(dataDir, "kuma.db"));
        assert.strictEqual(Database.uploadDir, path.join(dataDir, "upload/"));
        assert.strictEqual(Database.screenshotDir, path.join(dataDir, "screenshots/"));
        assert.strictEqual(Database.dockerTLSDir, path.join(dataDir, "docker-tls/"));

        assert.strictEqual(fs.existsSync(Database.dataDir), true);
        assert.strictEqual(fs.existsSync(Database.uploadDir), true);
        assert.strictEqual(fs.existsSync(Database.screenshotDir), true);
        assert.strictEqual(fs.existsSync(Database.dockerTLSDir), true);
    });

    test("is idempotent: running twice on an existing data dir does not throw", (t) => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-test-initdatadir-idempotent-"));
        t.after(() => {
            fs.rmSync(tmpBase, { recursive: true, force: true });
        });

        const dataDir = path.join(tmpBase, "data") + path.sep;
        const Database = {};

        assert.doesNotThrow(() => {
            initDataDir({ "data-dir": dataDir }, Database);
            initDataDir({ "data-dir": dataDir }, Database);
        });
        assert.strictEqual(fs.existsSync(Database.dataDir), true);
    });

    test("falls back to DATA_DIR env var when args['data-dir'] is not provided", (t) => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-test-initdatadir-env-"));
        t.after(() => {
            fs.rmSync(tmpBase, { recursive: true, force: true });
            delete process.env.DATA_DIR;
        });

        const dataDir = path.join(tmpBase, "env-data") + path.sep;
        process.env.DATA_DIR = dataDir;

        const Database = {};
        initDataDir({}, Database);

        assert.strictEqual(Database.dataDir, dataDir);
        assert.strictEqual(fs.existsSync(Database.dataDir), true);
    });
});

describe("database/legacy-patches.js: patchList structural integrity", () => {
    const entries = Object.entries(patchList);
    const keys = Object.keys(patchList);

    test("contains exactly 44 entries", () => {
        assert.strictEqual(keys.length, 44);
    });

    test("has no duplicate keys (object literal + JSON round-trip agree on count)", () => {
        const uniqueKeys = new Set(keys);
        assert.strictEqual(uniqueKeys.size, keys.length);
    });

    test("every key is a .sql filename", () => {
        for (const key of keys) {
            assert.match(key, /^patch-[a-z0-9_-]+\.sql$/, `Key "${key}" should look like a patch-*.sql filename`);
        }
    });

    test("every value is either boolean true, boolean false, or an object with a parents array", () => {
        for (const [ key, value ] of entries) {
            const isBoolean = typeof value === "boolean";
            const isParentsShape =
                typeof value === "object" &&
                value !== null &&
                Array.isArray(value.parents) &&
                value.parents.every((p) => typeof p === "string");

            assert.ok(
                isBoolean || isParentsShape,
                `Entry "${key}" has unexpected shape: ${JSON.stringify(value)}`
            );
        }
    });

    test("every 'parents' reference points to a key that also exists in patchList", () => {
        for (const [ key, value ] of entries) {
            if (typeof value === "object" && value !== null && Array.isArray(value.parents)) {
                for (const parent of value.parents) {
                    assert.ok(
                        Object.prototype.hasOwnProperty.call(patchList, parent),
                        `Entry "${key}" references parent "${parent}" which does not exist in patchList`
                    );
                }
            }
        }
    });

    test("known specific entries are present with their documented shape", () => {
        assert.strictEqual(patchList["patch-setting-value-type.sql"], true);
        assert.strictEqual(patchList["patch-monitor-tls-info-add-fk.sql"], true);
        assert.deepStrictEqual(patchList["patch-add-other-auth.sql"], { parents: ["patch-monitor-basic-auth.sql"] });
    });
});

describe("database/dialect.js: patchMysql2ColumnCompiler()", () => {
    test("replaces the mysql2 dialect's columnCompiler prototype method with one that builds a KumaColumnCompiler", () => {
        const { getDialectByNameOrAlias } = require("knex/lib/dialects");
        const KumaColumnCompiler = require("../../server/utils/knex/lib/dialects/mysql2/schema/mysql2-columncompiler");
        const mysql2 = getDialectByNameOrAlias("mysql2");

        const originalColumnCompiler = mysql2.prototype.columnCompiler;

        // Minimal fakes satisfying the base knex ColumnCompiler constructor's expectations.
        const fakeClient = {
            formatter: () => ({}),
            _escapeBinding: (v) => `'${v}'`,
        };
        const fakeTableCompiler = {};
        const fakeColumnBuilder = {
            _args: [],
            _type: "text",
            _statements: [],
            _modifiers: [],
        };

        try {
            patchMysql2ColumnCompiler();

            assert.notStrictEqual(
                mysql2.prototype.columnCompiler,
                originalColumnCompiler,
                "columnCompiler prototype method should have been replaced"
            );

            const instance = mysql2.prototype.columnCompiler.call(fakeClient, fakeTableCompiler, fakeColumnBuilder);
            assert.ok(instance instanceof KumaColumnCompiler, "Instance should be a KumaColumnCompiler");

            // Observe the actual monkey-patched behavior: KumaColumnCompiler overrides
            // defaultTo() to wrap string defaults for "text" columns in a MySQL/MariaDB
            // "default (...)" expression instead of the base class's plain default.
            const result = instance.defaultTo("hello");
            assert.strictEqual(result, "default ('hello')");
        } finally {
            // Restore the original prototype method so this test doesn't leak global
            // monkey-patch state into other test files sharing the same knex module cache.
            mysql2.prototype.columnCompiler = originalColumnCompiler;
        }
    });

    test("non-text column types fall back to the base class defaultTo behavior", () => {
        const { getDialectByNameOrAlias } = require("knex/lib/dialects");
        const mysql2 = getDialectByNameOrAlias("mysql2");
        const originalColumnCompiler = mysql2.prototype.columnCompiler;

        const fakeClient = {
            formatter: () => ({}),
            _escapeBinding: (v) => `'${v}'`,
        };
        const fakeTableCompiler = {};
        const fakeColumnBuilder = {
            _args: [],
            _type: "integer",
            _statements: [],
            _modifiers: [],
        };

        try {
            patchMysql2ColumnCompiler();
            const instance = mysql2.prototype.columnCompiler.call(fakeClient, fakeTableCompiler, fakeColumnBuilder);
            const result = instance.defaultTo(5);
            // Base MySQL ColumnCompiler.defaultTo formats non-text defaults as an escaped literal,
            // not wrapped in "default (...)".
            assert.strictEqual(result, "default '5'");
        } finally {
            mysql2.prototype.columnCompiler = originalColumnCompiler;
        }
    });
});
