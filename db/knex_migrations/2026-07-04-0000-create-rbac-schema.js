/**
 * Migration: Teams + granular RBAC multi-tenancy schema (ADR-0010, phase P1).
 *
 * Additive + dark-launch. It creates the RBAC tables, adds a nullable `team_id`
 * to the resource tables, and backfills every existing install into one
 * "Default Team" — all with the `rbacEnforced` setting left OFF, so runtime
 * behaviour is unchanged until a later phase flips it on.
 *
 * Table creation follows FK-dependency order (permission -> team -> role ->
 * role_permission -> team_user -> audit_log) so it also works on Postgres/MySQL,
 * where an FK target must already exist at create time. SQLite runs migrations
 * with foreign_keys OFF, which would otherwise mask an ordering bug.
 *
 * Seeding of the permission catalog + built-in roles is delegated to the
 * idempotent server/permissions/seed.js (single source of truth = catalog.js).
 *
 * Owner decisions folded in (2026-07-04): 1 role per (user, team); status pages
 * team-scoped with is_public; users are deactivated, never hard-deleted (so the
 * existing api_key/remote_instance user_id FKs are left untouched — no rebuild);
 * legacy API keys drop to the viewer role on the eventual flip.
 */

const { seedPermissionsAndRoles } = require("../../server/permissions/seed");

// The nine resource tables that gain a team_id ownership column.
const RESOURCE_TABLES = [
    "monitor",
    "maintenance",
    "notification",
    "proxy",
    "docker_host",
    "api_key",
    "remote_browser",
    "remote_instance",
    "tag",
];

/**
 * Apply the RBAC schema and backfill the existing install into a Default Team.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    // ---- 1. New tables, in FK-dependency order ----
    if (!(await knex.schema.hasTable("permission"))) {
        await knex.schema.createTable("permission", (table) => {
            table.increments("id");
            table.string("action", 100).notNullable().unique().comment("Canonical action, e.g. monitor:read");
            table.string("resource_type", 50).notNullable();
            table.string("verb", 50).notNullable();
            table.boolean("is_team_scoped").notNullable().defaultTo(true);
            table.string("description", 255);
        });
    }

    if (!(await knex.schema.hasTable("team"))) {
        await knex.schema.createTable("team", (table) => {
            table.increments("id");
            table.string("name", 255).notNullable();
            table.string("slug", 100).notNullable().unique();
            table.boolean("is_system").notNullable().defaultTo(false);
            table.boolean("active").notNullable().defaultTo(true);
            table.integer("created_by").unsigned().nullable().references("id").inTable("user").onDelete("SET NULL");
            table.datetime("created_date").defaultTo(knex.fn.now());
        });
    }

    if (!(await knex.schema.hasTable("role"))) {
        await knex.schema.createTable("role", (table) => {
            table.increments("id");
            table.string("name", 100).notNullable();
            table.string("slug", 100).notNullable();
            // team_id NULL = global built-in template; set = team-specific custom role.
            table.integer("team_id").unsigned().nullable().references("id").inTable("team").onDelete("CASCADE");
            table.boolean("is_system").notNullable().defaultTo(false);
            table.boolean("is_superadmin").notNullable().defaultTo(false);
            table.string("description", 255);
            table.datetime("created_date").defaultTo(knex.fn.now());
            table.unique(["team_id", "slug"]);
        });
    }

    if (!(await knex.schema.hasTable("role_permission"))) {
        await knex.schema.createTable("role_permission", (table) => {
            table.integer("role_id").unsigned().notNullable().references("id").inTable("role").onDelete("CASCADE");
            table
                .integer("permission_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("permission")
                .onDelete("CASCADE");
            table.primary(["role_id", "permission_id"]);
        });
    }

    if (!(await knex.schema.hasTable("team_user"))) {
        await knex.schema.createTable("team_user", (table) => {
            table.increments("id");
            table.integer("team_id").unsigned().notNullable().references("id").inTable("team").onDelete("CASCADE");
            table.integer("user_id").unsigned().notNullable().references("id").inTable("user").onDelete("CASCADE");
            // RESTRICT: a role in use by a membership cannot be deleted out from under it.
            table.integer("role_id").unsigned().notNullable().references("id").inTable("role").onDelete("RESTRICT");
            table.datetime("created_date").defaultTo(knex.fn.now());
            table.unique(["team_id", "user_id"]); // one role per (user, team) in v1
        });
    }

    if (!(await knex.schema.hasTable("audit_log"))) {
        await knex.schema.createTable("audit_log", (table) => {
            table.increments("id");
            table.integer("actor_user_id").unsigned().nullable().references("id").inTable("user").onDelete("SET NULL");
            table.integer("team_id").unsigned().nullable().references("id").inTable("team").onDelete("CASCADE");
            table.string("action", 100).notNullable();
            table.string("target_type", 50);
            table.integer("target_id");
            table.string("ip", 64);
            table.datetime("created_date").defaultTo(knex.fn.now());
            table.index("created_date");
            table.index("actor_user_id");
        });
    }

    // ---- 2. user: global RBAC/session flags ----
    if (!(await knex.schema.hasColumn("user", "is_superadmin"))) {
        await knex.schema.alterTable("user", (table) => {
            table.boolean("is_superadmin").notNullable().defaultTo(false);
        });
    }
    if (!(await knex.schema.hasColumn("user", "token_version"))) {
        await knex.schema.alterTable("user", (table) => {
            table.integer("token_version").notNullable().defaultTo(0);
        });
    }
    if (!(await knex.schema.hasColumn("user", "must_change_password"))) {
        await knex.schema.alterTable("user", (table) => {
            table.boolean("must_change_password").notNullable().defaultTo(false);
        });
    }

    // ---- 3. team_id on the nine resource tables (nullable at DB level; NOT NULL
    // is enforced in the write-path per ADR-0010 D2) ----
    for (const tableName of RESOURCE_TABLES) {
        if (!(await knex.schema.hasColumn(tableName, "team_id"))) {
            await knex.schema.alterTable(tableName, (table) => {
                table
                    .integer("team_id")
                    .unsigned()
                    .nullable()
                    .index()
                    .references("id")
                    .inTable("team")
                    .onDelete("RESTRICT");
            });
        }
    }

    // api_key additionally carries its scoped role.
    if (!(await knex.schema.hasColumn("api_key", "role_id"))) {
        await knex.schema.alterTable("api_key", (table) => {
            table.integer("role_id").unsigned().nullable().references("id").inTable("role").onDelete("RESTRICT");
        });
    }

    // ---- 4. status_page: team ownership + public flag. `group` is intentionally
    // NOT altered — it inherits tenancy from its parent status_page (ADR-0010 R1). ----
    if (!(await knex.schema.hasColumn("status_page", "team_id"))) {
        await knex.schema.alterTable("status_page", (table) => {
            table.integer("team_id").unsigned().nullable().references("id").inTable("team").onDelete("RESTRICT");
        });
    }
    if (!(await knex.schema.hasColumn("status_page", "is_public"))) {
        await knex.schema.alterTable("status_page", (table) => {
            table.boolean("is_public").notNullable().defaultTo(true);
        });
    }

    // ---- 5. Seed the permission catalog + built-in roles (idempotent) ----
    await seedPermissionsAndRoles(knex);

    // ---- 6. Backfill: fold the existing install into one Default Team ----
    let defaultTeam = await knex("team").where("slug", "default").first();
    if (!defaultTeam) {
        await knex("team").insert({
            name: "Default Team",
            slug: "default",
            is_system: true,
            active: true,
        });
        defaultTeam = await knex("team").where("slug", "default").first();
    }
    const defaultTeamId = defaultTeam.id;

    // Every existing resource row joins the Default Team (idempotent: only NULLs).
    for (const tableName of [...RESOURCE_TABLES, "status_page"]) {
        await knex(tableName).whereNull("team_id").update({ team_id: defaultTeamId });
    }

    // Legacy API keys drop to the read-only viewer role until re-scoped (never
    // inherit the owner's power on the flip).
    const viewerRole = await knex("role").whereNull("team_id").andWhere("slug", "viewer").first();
    if (viewerRole) {
        await knex("api_key").whereNull("role_id").update({ role_id: viewerRole.id });
    }

    // Every existing user becomes an owner of the Default Team.
    const ownerRole = await knex("role").whereNull("team_id").andWhere("slug", "owner").first();
    if (ownerRole) {
        const users = await knex("user").select("id");
        for (const user of users) {
            const membership = await knex("team_user")
                .where("team_id", defaultTeamId)
                .andWhere("user_id", user.id)
                .first();
            if (!membership) {
                await knex("team_user").insert({
                    team_id: defaultTeamId,
                    user_id: user.id,
                    role_id: ownerRole.id,
                });
            }
        }
    }

    // The lowest-id user becomes the bootstrap super admin (deterministic;
    // computed first to avoid the MySQL "update a table referenced in a
    // subquery" restriction).
    const firstUser = await knex("user").min("id as minId").first();
    if (firstUser && firstUser.minId !== null && firstUser.minId !== undefined) {
        await knex("user").where("id", firstUser.minId).update({ is_superadmin: true });
    }

    // ---- 7. Dark-launch flag: enforcement OFF ----
    const flag = await knex("setting").where("key", "rbacEnforced").first();
    if (!flag) {
        await knex("setting").insert({
            key: "rbacEnforced",
            value: JSON.stringify(false),
            type: "boolean",
        });
    }
};

/**
 * Roll back the RBAC schema. Drops FK-bearing columns before the tables they
 * reference, so it also works where foreign keys are enforced.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
    // MySQL/MariaDB refuse to drop a column while its FK constraint exists, so
    // there the constraint must be dropped first. SQLite (table rebuild) and
    // Postgres (automatic constraint drop) do not need the explicit step.
    const clientName = knex.client.dialect || (knex.client.config && knex.client.config.client) || "";
    const isMysqlFamily = clientName === "mysql" || clientName === "mysql2" || clientName === "mariadb";

    /**
     * Drop a column, first removing its FK constraint where the engine needs it.
     * @param {string} tableName Table to alter.
     * @param {string} col Column to drop.
     * @param {boolean} hasForeignKey Whether the column carries an FK constraint.
     * @returns {Promise<void>}
     */
    const dropCol = async (tableName, col, hasForeignKey) => {
        if (!(await knex.schema.hasColumn(tableName, col))) {
            return;
        }
        await knex.schema.alterTable(tableName, (table) => {
            if (hasForeignKey && isMysqlFamily) {
                table.dropForeign([col]);
            }
            table.dropColumn(col);
        });
    };

    await dropCol("status_page", "is_public", false);
    await dropCol("status_page", "team_id", true);
    await dropCol("api_key", "role_id", true);
    for (const tableName of RESOURCE_TABLES) {
        await dropCol(tableName, "team_id", true);
    }
    for (const col of ["is_superadmin", "token_version", "must_change_password"]) {
        await dropCol("user", col, false);
    }

    await knex.schema.dropTableIfExists("team_user");
    await knex.schema.dropTableIfExists("role_permission");
    await knex.schema.dropTableIfExists("audit_log");
    await knex.schema.dropTableIfExists("role");
    await knex.schema.dropTableIfExists("team");
    await knex.schema.dropTableIfExists("permission");

    await knex("setting").where("key", "rbacEnforced").del();
};
