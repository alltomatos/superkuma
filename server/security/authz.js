/**
 * Central authorization choke-point for the Teams + RBAC model.
 *
 * Every authorization decision in the backend is meant to funnel through this
 * module (P3 of ADR-0010). It is intentionally pure and database-free: callers
 * resolve an {@link Actor} (login / API-key middleware in P2) and, for
 * team-scoped resources, resolve the owning team id server-side before asking
 * `can()`/`requirePermission()`. A team id is NEVER accepted from client input.
 *
 * Dark-launch: while enforcement is disabled (the default, driven by the
 * `rbacEnforced` setting), every check passes and list scoping falls back to
 * the legacy per-user filter, keeping behaviour byte-identical to the pre-RBAC
 * single-user model.
 *
 * See docs/adr/0010-teams-rbac-multitenancy.md §4.
 */

const { isValidAction, isTeamScoped, expandBuiltinRole } = require("../permissions/catalog");

/**
 * Whether RBAC enforcement is active. Defaults to false (dark-launch OFF).
 * @type {boolean}
 */
let enforcementEnabled = false;

/**
 * Error thrown when an actor lacks a required permission. Handlers can catch
 * this to translate it into a socket/HTTP "forbidden" response.
 */
class ForbiddenError extends Error {
    /**
     * @param {string} message Human-readable reason the access was denied.
     */
    constructor(message) {
        super(message);
        this.name = "ForbiddenError";
    }
}

/**
 * @typedef {object} Membership
 * @property {number} teamId The team id.
 * @property {number|null} roleId The role id assigned within the team.
 * @property {string|null} roleSlug The role slug (used to expand built-in grants).
 * @property {Set<string>} permissions The effective action set within the team.
 */

/**
 * @typedef {object} Actor
 * @property {number} userId The authenticated user id.
 * @property {boolean} isSuperadmin Whether the user is a global super admin.
 * @property {number|null} activeTeamId The team the actor is currently acting in.
 * @property {Map<number, Membership>} memberships Team id -> membership.
 */

/**
 * Enable or disable RBAC enforcement globally.
 * @param {boolean} enabled Whether enforcement should be active.
 * @returns {void}
 */
function setEnforcementEnabled(enabled) {
    enforcementEnabled = Boolean(enabled);
}

/**
 * Whether RBAC enforcement is currently active.
 * @returns {boolean} True if enforcement is on.
 */
function isEnforcementEnabled() {
    return enforcementEnabled;
}

/**
 * Build an {@link Actor} from an already-resolved principal and its team
 * memberships. This is a pure constructor: the caller is responsible for
 * querying `team_user` + `role_permission` and passing the rows in. For each
 * membership the effective permission set is taken from an explicit
 * `permissions` list (Set or array) when provided, otherwise expanded from the
 * built-in role slug via the catalog.
 * @param {object} principal The authenticated principal.
 * @param {number} principal.userId The user id.
 * @param {boolean} principal.isSuperadmin Whether the user is a super admin.
 * @param {Array<object>} membershipRows Raw membership rows for the user.
 * @param {number} activeTeamId The team to act in; defaults to the first membership.
 * @returns {Actor} The constructed actor.
 */
function buildActor(principal, membershipRows, activeTeamId) {
    const memberships = new Map();

    for (const row of membershipRows || []) {
        let permissions;
        if (row.permissions instanceof Set) {
            permissions = row.permissions;
        } else if (Array.isArray(row.permissions)) {
            permissions = new Set(row.permissions);
        } else {
            permissions = expandBuiltinRole(row.roleSlug);
        }

        memberships.set(row.teamId, {
            teamId: row.teamId,
            roleId: row.roleId === undefined ? null : row.roleId,
            roleSlug: row.roleSlug === undefined ? null : row.roleSlug,
            permissions,
        });
    }

    let active = activeTeamId === undefined ? null : activeTeamId;
    if (active === null && memberships.size > 0) {
        active = memberships.keys().next().value;
    }

    return {
        userId: principal.userId,
        isSuperadmin: Boolean(principal.isSuperadmin),
        activeTeamId: active,
        memberships,
    };
}

/**
 * Decide whether an actor may perform an action, optionally against a resource.
 *
 * Order of evaluation (ADR-0010 §4):
 * 1. If enforcement is disabled, allow (flag-OFF is fully permissive).
 * 2. Super admins bypass all checks.
 * 3. Global (non-team-scoped) actions: allowed if ANY membership grants them.
 * 4. Team-scoped actions: the resource's server-resolved `teamId` must match a
 * membership that grants the action. `teamId` is never taken from client
 * input — resolve it from the resource id first (see authorizeResource).
 * @param {Actor} actor The actor requesting access.
 * @param {string} action Canonical action string (must exist in the catalog).
 * @param {object} resource The target; team-scoped actions require a resolved teamId.
 * @param {number} resource.teamId The server-resolved owning team id.
 * @returns {boolean} True if the action is permitted.
 * @throws {Error} If the action is not part of the permission catalog.
 */
function can(actor, action, resource) {
    if (!enforcementEnabled) {
        return true;
    }
    if (!isValidAction(action)) {
        throw new Error(`Unknown permission action: ${action}`);
    }
    if (actor && actor.isSuperadmin) {
        return true;
    }
    if (!actor || !actor.memberships) {
        return false;
    }

    if (!isTeamScoped(action)) {
        for (const membership of actor.memberships.values()) {
            if (membership.permissions.has(action)) {
                return true;
            }
        }
        return false;
    }

    const teamId = resource ? resource.teamId : undefined;
    if (teamId === undefined || teamId === null) {
        return false;
    }
    const membership = actor.memberships.get(teamId);
    if (!membership) {
        return false;
    }
    return membership.permissions.has(action);
}

/**
 * Assert that an actor may perform an action, throwing if not.
 * @param {Actor} actor The actor requesting access.
 * @param {string} action Canonical action string.
 * @param {object} resource The target; team-scoped actions require a resolved teamId.
 * @returns {void}
 * @throws {ForbiddenError} If the actor lacks the permission.
 * @throws {Error} If the action is not part of the permission catalog.
 */
function requirePermission(actor, action, resource) {
    if (!can(actor, action, resource)) {
        throw new ForbiddenError(`Permission denied: ${action}`);
    }
}

/**
 * Resolve a resource's owning team server-side, then authorize a team-scoped
 * action against it. The team id is loaded via `teamIdLoader` from the resource
 * id — never accepted from the caller/client — which closes the escalation hole
 * where a client supplies a forged team id (ADR-0010 §4.3, R3).
 * @param {Actor} actor The actor requesting access.
 * @param {string} action Canonical (team-scoped) action string.
 * @param {string} resourceType The resource family (e.g. "monitor").
 * @param {number} resourceId The resource id to resolve the owning team from.
 * @param {Function} teamIdLoader Async (resourceType, resourceId) => teamId|null.
 * @returns {Promise<boolean>} True if the action is permitted.
 * @throws {Error} If the action is not part of the permission catalog.
 */
async function authorizeResource(actor, action, resourceType, resourceId, teamIdLoader) {
    if (!enforcementEnabled) {
        return true;
    }
    const teamId = await teamIdLoader(resourceType, resourceId);
    return can(actor, action, { type: resourceType, teamId });
}

/**
 * Convenience wrapper around {@link authorizeResource} for call sites that want
 * to throw rather than branch on a boolean. This is the call every retrofitted
 * handler/gate should use (ADR-0010 phase P3): while enforcement is OFF it is a
 * pure no-op (never even calls the loader), so it can be inserted ahead of an
 * existing legacy ownership check without changing today's behaviour. Existing
 * `WHERE ... AND user_id = ?` predicates are intentionally left in place during
 * P3 — only P4 (tied to the enforcement flip) switches the trusted column to
 * `team_id`, avoiding a window where a stale/incomplete team model could grant
 * broader access than the current per-user check for an existing multi-user
 * install.
 * @param {Actor} actor The actor requesting access.
 * @param {string} action Canonical (team-scoped) action string.
 * @param {string} resourceType The resource family (e.g. "monitor").
 * @param {number} resourceId The resource id to resolve the owning team from.
 * @param {Function} teamIdLoader Async (resourceType, resourceId) => teamId|null.
 * @returns {Promise<void>}
 * @throws {ForbiddenError} If the actor lacks the permission (enforcement ON only).
 */
async function requireResource(actor, action, resourceType, resourceId, teamIdLoader) {
    if (!(await authorizeResource(actor, action, resourceType, resourceId, teamIdLoader))) {
        throw new ForbiddenError(`Permission denied: ${action}`);
    }
}

/**
 * Build a SQL WHERE fragment restricting a list query to rows an actor may see.
 * Enforced mode filters by the actor's team memberships (optionally only those
 * granting a given read permission); flag-OFF falls back to the legacy per-user
 * filter so existing single-user queries are unchanged.
 * @param {Actor} actor The actor running the query.
 * @param {object} options Options bag.
 * @param {string} options.column The trusted team-id column name (default "team_id").
 * @param {string} options.permission Optional action; only include teams granting it.
 * @returns {object} An object with `clause` (string) and `params` (array).
 */
function scopeFilter(actor, options) {
    const opts = options || {};
    const column = opts.column || "team_id";

    if (!enforcementEnabled) {
        return { clause: "user_id = ?", params: [actor.userId] };
    }
    if (actor && actor.isSuperadmin) {
        return { clause: "1 = 1", params: [] };
    }
    if (!actor || !actor.memberships || actor.memberships.size === 0) {
        return { clause: "1 = 0", params: [] };
    }

    const teamIds = [];
    for (const membership of actor.memberships.values()) {
        if (opts.permission && !membership.permissions.has(opts.permission)) {
            continue;
        }
        teamIds.push(membership.teamId);
    }
    if (teamIds.length === 0) {
        return { clause: "1 = 0", params: [] };
    }

    const placeholders = teamIds.map(() => "?").join(", ");
    return { clause: `${column} IN (${placeholders})`, params: teamIds };
}

module.exports = {
    ForbiddenError,
    setEnforcementEnabled,
    isEnforcementEnabled,
    buildActor,
    can,
    requirePermission,
    authorizeResource,
    requireResource,
    scopeFilter,
};
