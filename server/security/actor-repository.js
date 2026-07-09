/**
 * Builds RBAC {@link Actor}s from the database (ADR-0010).
 *
 * This is the bridge between the persisted team/role/permission tables and the
 * pure decision logic in authz.js. It is used to attach `socket.actor` at login
 * and to derive the permission payload sent to the frontend.
 */

const { R } = require("redbean-node");
const { buildActor } = require("./authz");

/**
 * Load a user's memberships with their effective permission sets, using the
 * knex query builder so identifiers (incl. the reserved word "role") are quoted
 * correctly across SQLite/MySQL/MariaDB/Postgres.
 * @param {number} userId The user id.
 * @returns {Promise<Array<object>>} Membership rows for buildActor().
 */
async function loadMembershipRows(userId) {
    const rows = await R.knex("team_user as tu")
        .join("role as r", "r.id", "tu.role_id")
        .leftJoin("role_permission as rp", "rp.role_id", "r.id")
        .leftJoin("permission as p", "p.id", "rp.permission_id")
        .where("tu.user_id", userId)
        .select("tu.team_id as teamId", "tu.role_id as roleId", "r.slug as roleSlug", "p.action as action");

    const byTeam = new Map();
    for (const row of rows) {
        if (!byTeam.has(row.teamId)) {
            byTeam.set(row.teamId, {
                teamId: row.teamId,
                roleId: row.roleId,
                roleSlug: row.roleSlug,
                permissions: new Set(),
            });
        }
        if (row.action) {
            byTeam.get(row.teamId).permissions.add(row.action);
        }
    }
    return Array.from(byTeam.values());
}

/**
 * Build an actor for an authenticated user bean.
 * @param {object} user The user bean (needs id, is_superadmin).
 * @param {number} activeTeamId Optional team to act in; defaults to first membership.
 * @returns {Promise<object>} The constructed actor.
 */
async function buildActorForUser(user, activeTeamId) {
    const membershipRows = await loadMembershipRows(user.id);
    return buildActor({ userId: user.id, isSuperadmin: Boolean(user.is_superadmin) }, membershipRows, activeTeamId);
}

/**
 * Load the set of action strings granted by a single role.
 * @param {number} roleId The role id.
 * @returns {Promise<Set<string>>} The granted actions.
 */
async function loadRolePermissions(roleId) {
    const rows = await R.knex("role_permission as rp")
        .join("permission as p", "p.id", "rp.permission_id")
        .where("rp.role_id", roleId)
        .select("p.action as action");
    return new Set(rows.map((r) => r.action));
}

/**
 * Build an actor for an API key. The key is capped to its own `role_id` within
 * its `team_id` and NEVER inherits the owner's super-admin (ADR-0010 R2).
 * @param {object} keyBean The api_key bean (needs user_id, team_id, role_id).
 * @returns {Promise<object>} The constructed actor.
 */
async function buildActorForApiKey(keyBean) {
    const userId = keyBean ? keyBean.user_id : null;
    if (!keyBean || !keyBean.team_id || !keyBean.role_id) {
        return buildActor({ userId, isSuperadmin: false }, [], null);
    }
    const permissions = await loadRolePermissions(keyBean.role_id);
    const membershipRows = [{ teamId: keyBean.team_id, roleId: keyBean.role_id, roleSlug: null, permissions }];
    return buildActor({ userId, isSuperadmin: false }, membershipRows, keyBean.team_id);
}

/**
 * Build the current-user + teams permission payload sent to the frontend in the
 * "info" event, so the UI can render role-gated controls (server-side stays the
 * boundary).
 * @param {object} user The user bean.
 * @param {object} actor The actor built for the user.
 * @returns {Promise<object>} An object with currentUser, teams and activeTeamId.
 */
async function buildPermissionPayload(user, actor) {
    const teamIds = Array.from(actor.memberships.keys());
    let teamRows = [];
    if (teamIds.length > 0) {
        teamRows = await R.knex("team").whereIn("id", teamIds).select("id", "name", "slug");
    }
    const teamById = new Map(teamRows.map((t) => [t.id, t]));

    const teams = [];
    for (const m of actor.memberships.values()) {
        const t = teamById.get(m.teamId) || {};
        teams.push({
            id: m.teamId,
            name: t.name || null,
            slug: t.slug || null,
            role: m.roleSlug || null,
            permissions: Array.from(m.permissions),
        });
    }

    return {
        currentUser: {
            id: user.id,
            username: user.username,
            isSuperadmin: Boolean(user.is_superadmin),
            mustChangePassword: Boolean(user.must_change_password),
        },
        teams,
        activeTeamId: actor.activeTeamId,
    };
}

/**
 * Whether at least one active superadmin exists. Intended as a guard before
 * any user-deactivation/role-change mutation that could leave the system
 * with no way to grant global admin access.
 * @returns {Promise<boolean>} True if at least one active superadmin exists.
 */
async function hasActiveSuperadmin() {
    const count = await R.count("user", "is_superadmin = 1 AND active = 1");
    return count > 0;
}

/**
 * The team a newly created resource should be assigned to: the actor's
 * currently active team, falling back to the Default Team if the actor has
 * none (e.g. was just removed from every team they belonged to). Used by
 * every resource-creation handler so a new row can never silently end up
 * team_id = NULL (an invisible orphan outside any team's scope).
 * @param {object} actor The acting actor (socket.actor), or null/undefined.
 * @returns {Promise<number|null>} A team id, or null if even the Default Team is missing.
 */
async function resolveTeamIdForCreate(actor) {
    if (actor && actor.activeTeamId) {
        return actor.activeTeamId;
    }
    const defaultTeam = await R.findOne("team", "slug = ?", ["default"]);
    return defaultTeam ? defaultTeam.id : null;
}

module.exports = {
    buildActorForUser,
    buildActorForApiKey,
    buildPermissionPayload,
    hasActiveSuperadmin,
    resolveTeamIdForCreate,
};
