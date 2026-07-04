/**
 * Idempotent seeding of the RBAC permission catalog + built-in roles.
 *
 * The single source of truth is server/permissions/catalog.js. This seeder is
 * safe to run repeatedly (it checks for existence before every insert), so it
 * can be invoked from the P1 migration AND, later, at boot to converge new
 * catalog entries onto an already-migrated database.
 *
 * See docs/adr/0010-teams-rbac-multitenancy.md §3.
 */

const { PERMISSIONS, BUILTIN_ROLES } = require("./catalog");

/**
 * Seed the permission rows, built-in roles and their grants, idempotently.
 * Built-in roles are stored as global templates (team_id NULL).
 * @param {object} knex A Knex instance to run the inserts against.
 * @returns {Promise<void>}
 */
async function seedPermissionsAndRoles(knex) {
    // 1. Permissions — unique by action string.
    for (const p of PERMISSIONS) {
        const existing = await knex("permission").where("action", p.action).first();
        if (!existing) {
            await knex("permission").insert({
                action: p.action,
                resource_type: p.resourceType,
                verb: p.verb,
                is_team_scoped: p.isTeamScoped ? 1 : 0,
                description: p.description,
            });
        }
    }

    // 2. Built-in roles (global templates, team_id NULL) + their grants.
    for (const role of BUILTIN_ROLES) {
        let roleRow = await knex("role").whereNull("team_id").andWhere("slug", role.slug).first();
        if (!roleRow) {
            await knex("role").insert({
                name: role.name,
                slug: role.slug,
                team_id: null,
                is_system: 1,
                is_superadmin: role.isSuperadmin ? 1 : 0,
                description: role.description,
            });
            roleRow = await knex("role").whereNull("team_id").andWhere("slug", role.slug).first();
        }

        for (const action of role.permissions) {
            const permRow = await knex("permission").where("action", action).first();
            if (!permRow) {
                continue;
            }
            const link = await knex("role_permission")
                .where("role_id", roleRow.id)
                .andWhere("permission_id", permRow.id)
                .first();
            if (!link) {
                await knex("role_permission").insert({
                    role_id: roleRow.id,
                    permission_id: permRow.id,
                });
            }
        }
    }
}

module.exports = { seedPermissionsAndRoles };
