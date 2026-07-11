/**
 * Permission catalog + built-in role definitions for the Teams + RBAC model.
 *
 * This module is pure data + pure helpers. It performs NO database access and
 * is NOT wired into any handler yet (P0 of ADR-0010). Seeding these rows into
 * the `permission` / `role` / `role_permission` tables happens in a later phase
 * (P1); this file is the single source of truth those seeds read from.
 *
 * Deny-by-default: an action is only ever granted if it is present both in this
 * catalog AND in the effective permission set of a role the actor holds.
 *
 * See docs/adr/0010-teams-rbac-multitenancy.md §3.
 */

/**
 * @typedef {object} PermissionDef
 * @property {string} action Canonical action string, e.g. "monitor:read".
 * @property {string} resourceType Resource family the action belongs to.
 * @property {string} verb Action verb, e.g. "read", "manage_state".
 * @property {boolean} isTeamScoped Whether the action is evaluated against a team.
 * @property {string} description Human-readable description.
 */

/**
 * @typedef {object} RoleDef
 * @property {string} slug Stable machine slug, e.g. "viewer".
 * @property {string} name Display name.
 * @property {boolean} isSystem Whether this is a built-in (non-editable) role.
 * @property {boolean} isSuperadmin Whether holders bypass all permission checks.
 * @property {string} description Human-readable description.
 * @property {Array<string>} permissions Action strings granted by the role.
 */

/**
 * Build a permission definition object.
 * @param {string} resourceType Resource family (e.g. "monitor").
 * @param {string} verb Action verb (e.g. "read").
 * @param {boolean} isTeamScoped Whether the action is evaluated against a team.
 * @param {string} description Human-readable description.
 * @returns {PermissionDef} The permission definition.
 */
function perm(resourceType, verb, isTeamScoped, description) {
    return {
        action: resourceType + ":" + verb,
        resourceType,
        verb,
        isTeamScoped,
        description,
    };
}

/**
 * Canonical catalog of every permission the system understands.
 * @type {Array<PermissionDef>}
 */
const PERMISSIONS = [
    // Monitors
    perm("monitor", "read", true, "View monitors and their heartbeats/stats"),
    perm("monitor", "create", true, "Create monitors"),
    perm("monitor", "update", true, "Edit monitors, their tags and notifications"),
    perm("monitor", "delete", true, "Delete monitors"),
    perm("monitor", "manage_state", true, "Pause/resume monitors and clear their data"),

    // Maintenance windows
    perm("maintenance", "read", true, "View maintenance windows"),
    perm("maintenance", "create", true, "Create maintenance windows"),
    perm("maintenance", "update", true, "Edit maintenance windows"),
    perm("maintenance", "delete", true, "Delete maintenance windows"),

    // Notifications
    perm("notification", "read", true, "View notifications"),
    perm("notification", "manage", true, "Create, edit and delete notifications"),

    // Proxies
    perm("proxy", "read", true, "View proxies"),
    perm("proxy", "manage", true, "Create, edit and delete proxies"),

    // Docker hosts
    perm("docker_host", "read", true, "View docker hosts"),
    perm("docker_host", "manage", true, "Create, edit and delete docker hosts"),

    // Remote browsers
    perm("remote_browser", "read", true, "View remote browsers"),
    perm("remote_browser", "manage", true, "Create, edit and delete remote browsers"),

    // Remote instances (federation agents)
    perm("remote_instance", "read", true, "View federation agents"),
    perm("remote_instance", "manage", true, "Register and remove federation agents"),

    // Status pages
    perm("status_page", "read", true, "View status pages"),
    perm("status_page", "manage", true, "Create, edit and delete status pages and incidents"),

    // Team dashboards (ADR-0016)
    perm("dashboard", "read", true, "View team dashboards"),
    perm("dashboard", "manage", true, "Create, edit and delete team dashboards"),

    // API keys
    perm("api_key", "read", true, "View API keys"),
    perm("api_key", "manage", true, "Create, renew and revoke API keys"),

    // Tags
    perm("tag", "read", true, "View tags"),
    perm("tag", "manage", true, "Create, edit and delete tags"),

    // Team-scoped settings
    perm("settings", "read", true, "View team settings"),
    perm("settings", "manage", true, "Edit team settings"),

    // Team self-management
    perm("team", "read", true, "View a team's details and members"),
    perm("team", "manage", true, "Rename, deactivate and configure a team"),
    perm("team", "member_manage", true, "Add/remove members and assign roles"),

    // Global (cross-team) permissions — only ever granted to super admins in v1
    perm("user", "manage", false, "Create, deactivate and reset users"),
    perm("team", "create", false, "Create new teams"),
    perm("role", "manage", false, "Define custom roles and their permissions"),
    perm("audit", "read", false, "Read the audit log"),
];

/**
 * Fast lookup of a permission definition by its action string.
 * @type {Map<string, PermissionDef>}
 */
const PERMISSION_BY_ACTION = new Map(PERMISSIONS.map((p) => [p.action, p]));

/**
 * The set of every valid action string.
 * @type {Set<string>}
 */
const PERMISSION_ACTIONS = new Set(PERMISSION_BY_ACTION.keys());

// Convenience groupings used to compose the built-in role grants.
const READ_ACTIONS = PERMISSIONS.filter((p) => p.isTeamScoped && p.verb === "read").map((p) => p.action);
const ALL_TEAM_SCOPED = PERMISSIONS.filter((p) => p.isTeamScoped).map((p) => p.action);
const ALL_ACTIONS = PERMISSIONS.map((p) => p.action);

const EDITOR_EXTRA = [
    "monitor:create",
    "monitor:update",
    "monitor:delete",
    "monitor:manage_state",
    "maintenance:create",
    "maintenance:update",
    "maintenance:delete",
    "notification:manage",
    "proxy:manage",
    "docker_host:manage",
    "remote_browser:manage",
    "remote_instance:manage",
    "status_page:manage",
    "tag:manage",
    "dashboard:manage",
];

// Admin manages the team's resources, members, keys and settings, but cannot
// deactivate/delete the team itself — that is reserved for the owner.
const ADMIN_EXTRA = ["api_key:manage", "settings:manage", "team:member_manage"];

/**
 * Built-in, non-editable roles seeded once at bootstrap (team_id NULL templates).
 * @type {Array<RoleDef>}
 */
const BUILTIN_ROLES = [
    {
        slug: "superadmin",
        name: "Super Admin",
        isSystem: true,
        isSuperadmin: true,
        description: "Full cross-team access. Bypasses all permission checks.",
        permissions: ALL_ACTIONS.slice(),
    },
    {
        slug: "owner",
        name: "Owner",
        isSystem: true,
        isSuperadmin: false,
        description: "Full control of a single team, including deactivating it.",
        permissions: ALL_TEAM_SCOPED.slice(),
    },
    {
        slug: "admin",
        name: "Admin",
        isSystem: true,
        isSuperadmin: false,
        description: "Manage a team's resources, members, keys and settings (cannot deactivate the team).",
        permissions: [...READ_ACTIONS, ...EDITOR_EXTRA, ...ADMIN_EXTRA],
    },
    {
        slug: "editor",
        name: "Editor",
        isSystem: true,
        isSuperadmin: false,
        description: "Create and edit monitoring resources; no team, key or user administration.",
        permissions: [...READ_ACTIONS, ...EDITOR_EXTRA],
    },
    {
        slug: "viewer",
        name: "Viewer",
        isSystem: true,
        isSuperadmin: false,
        description: "Read-only access to a team's resources.",
        permissions: READ_ACTIONS.slice(),
    },
];

/**
 * Fast lookup of a built-in role definition by slug.
 * @type {Map<string, RoleDef>}
 */
const BUILTIN_ROLE_BY_SLUG = new Map(BUILTIN_ROLES.map((r) => [r.slug, r]));

/**
 * Look up a permission definition by its action string.
 * @param {string} action Canonical action string.
 * @returns {PermissionDef|undefined} The definition, or undefined if unknown.
 */
function getPermission(action) {
    return PERMISSION_BY_ACTION.get(action);
}

/**
 * Whether an action string is part of the known catalog.
 * @param {string} action Canonical action string.
 * @returns {boolean} True if the action exists in the catalog.
 */
function isValidAction(action) {
    return PERMISSION_ACTIONS.has(action);
}

/**
 * Whether an action is evaluated against a team (team-scoped) as opposed to
 * being a global, cross-team permission.
 * @param {string} action Canonical action string.
 * @returns {boolean} True if the action is team-scoped.
 * @throws {Error} If the action is not part of the catalog.
 */
function isTeamScoped(action) {
    const def = PERMISSION_BY_ACTION.get(action);
    if (!def) {
        throw new Error(`Unknown permission action: ${action}`);
    }
    return def.isTeamScoped;
}

/**
 * Get a built-in role definition by slug.
 * @param {string} slug Role slug (e.g. "viewer").
 * @returns {RoleDef|undefined} The role definition, or undefined if not built-in.
 */
function getBuiltinRole(slug) {
    return BUILTIN_ROLE_BY_SLUG.get(slug);
}

/**
 * Expand a built-in role slug into the set of action strings it grants.
 * @param {string} slug Role slug.
 * @returns {Set<string>} The granted actions (empty set if the slug is unknown).
 */
function expandBuiltinRole(slug) {
    const role = BUILTIN_ROLE_BY_SLUG.get(slug);
    if (!role) {
        return new Set();
    }
    return new Set(role.permissions);
}

module.exports = {
    PERMISSIONS,
    PERMISSION_ACTIONS,
    BUILTIN_ROLES,
    getPermission,
    isValidAction,
    isTeamScoped,
    getBuiltinRole,
    expandBuiltinRole,
};
