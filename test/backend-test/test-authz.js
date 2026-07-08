const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");

const catalog = require("../../server/permissions/catalog");
const authz = require("../../server/security/authz");

const {
    PERMISSIONS,
    PERMISSION_ACTIONS,
    BUILTIN_ROLES,
    isValidAction,
    isTeamScoped,
    getBuiltinRole,
    expandBuiltinRole,
} = catalog;

const {
    buildActor,
    can,
    requirePermission,
    authorizeResource,
    requireResource,
    scopeFilter,
    setEnforcementEnabled,
    isEnforcementEnabled,
    ForbiddenError,
} = authz;

// -------------------------------------------------------------------------
// Catalog
// -------------------------------------------------------------------------
describe("permission catalog", () => {
    test("every action string is unique", () => {
        const actions = PERMISSIONS.map((p) => p.action);
        assert.strictEqual(actions.length, PERMISSION_ACTIONS.size, "duplicate action strings detected");
    });

    test("core team-scoped and global actions exist with correct scoping", () => {
        assert.ok(isValidAction("monitor:read"));
        assert.ok(isValidAction("tag:manage"));
        assert.ok(isValidAction("user:manage"));

        assert.strictEqual(isTeamScoped("monitor:read"), true);
        assert.strictEqual(isTeamScoped("tag:manage"), true);
        assert.strictEqual(isTeamScoped("status_page:manage"), true);

        // Global (cross-team) actions
        assert.strictEqual(isTeamScoped("user:manage"), false);
        assert.strictEqual(isTeamScoped("team:create"), false);
        assert.strictEqual(isTeamScoped("role:manage"), false);
        assert.strictEqual(isTeamScoped("audit:read"), false);
    });

    test("isValidAction is false for unknown actions", () => {
        assert.strictEqual(isValidAction("monitor:destroy"), false);
        assert.strictEqual(isValidAction("nope"), false);
    });

    test("isTeamScoped throws on an unknown action", () => {
        assert.throws(() => isTeamScoped("monitor:destroy"), /Unknown permission action/);
    });

    test("built-in roles form a strict privilege ladder viewer < editor < admin < owner", () => {
        const viewer = new Set(getBuiltinRole("viewer").permissions);
        const editor = new Set(getBuiltinRole("editor").permissions);
        const admin = new Set(getBuiltinRole("admin").permissions);
        const owner = new Set(getBuiltinRole("owner").permissions);

        for (const a of viewer) {
            assert.ok(editor.has(a), `editor should include viewer action ${a}`);
        }
        for (const a of editor) {
            assert.ok(admin.has(a), `admin should include editor action ${a}`);
        }
        for (const a of admin) {
            assert.ok(owner.has(a), `owner should include admin action ${a}`);
        }

        // The ladder must be strict at each rung.
        assert.ok(editor.size > viewer.size, "editor must add permissions over viewer");
        assert.ok(admin.size > editor.size, "admin must add permissions over editor");
        assert.ok(owner.size > admin.size, "owner must add permissions over admin");
    });

    test("only owner can deactivate the team (team:manage)", () => {
        assert.ok(new Set(getBuiltinRole("owner").permissions).has("team:manage"));
        assert.ok(!new Set(getBuiltinRole("admin").permissions).has("team:manage"));
    });

    test("viewer is strictly read-only", () => {
        for (const action of getBuiltinRole("viewer").permissions) {
            const def = PERMISSIONS.find((p) => p.action === action);
            assert.strictEqual(def.verb, "read", `viewer holds a non-read action: ${action}`);
        }
    });

    test("superadmin role is flagged and holds every action; no other built-in is superadmin", () => {
        const superadmin = getBuiltinRole("superadmin");
        assert.strictEqual(superadmin.isSuperadmin, true);
        assert.strictEqual(superadmin.permissions.length, PERMISSIONS.length);

        for (const role of BUILTIN_ROLES) {
            if (role.slug !== "superadmin") {
                assert.strictEqual(role.isSuperadmin, false, `${role.slug} must not be superadmin`);
            }
        }
    });

    test("no built-in non-superadmin role grants a global permission (v1 least-privilege)", () => {
        for (const role of BUILTIN_ROLES) {
            if (role.slug === "superadmin") {
                continue;
            }
            for (const action of role.permissions) {
                assert.strictEqual(
                    isTeamScoped(action),
                    true,
                    `${role.slug} unexpectedly grants global action ${action}`
                );
            }
        }
    });

    test("every action referenced by a role exists in the catalog (no dangling grants)", () => {
        for (const role of BUILTIN_ROLES) {
            for (const action of role.permissions) {
                assert.ok(isValidAction(action), `role ${role.slug} references unknown action ${action}`);
            }
        }
    });

    test("expandBuiltinRole returns a Set; unknown slug yields an empty set", () => {
        assert.ok(expandBuiltinRole("viewer") instanceof Set);
        assert.ok(expandBuiltinRole("viewer").has("monitor:read"));
        assert.strictEqual(expandBuiltinRole("does-not-exist").size, 0);
    });
});

// -------------------------------------------------------------------------
// buildActor
// -------------------------------------------------------------------------
describe("buildActor", () => {
    test("builds memberships from an explicit permissions array", () => {
        const actor = buildActor(
            { userId: 7, isSuperadmin: false },
            [{ teamId: 3, roleId: 9, permissions: ["monitor:read", "monitor:update"] }],
            3
        );
        assert.strictEqual(actor.userId, 7);
        assert.strictEqual(actor.isSuperadmin, false);
        assert.strictEqual(actor.activeTeamId, 3);
        assert.ok(actor.memberships.get(3).permissions.has("monitor:update"));
        assert.strictEqual(actor.memberships.get(3).roleId, 9);
    });

    test("expands permissions from a built-in role slug when none are given", () => {
        const actor = buildActor({ userId: 1, isSuperadmin: false }, [{ teamId: 2, roleSlug: "viewer" }]);
        const m = actor.memberships.get(2);
        assert.ok(m.permissions.has("monitor:read"));
        assert.ok(!m.permissions.has("monitor:create"));
    });

    test("activeTeamId defaults to the first membership when not provided", () => {
        const actor = buildActor({ userId: 1, isSuperadmin: false }, [
            { teamId: 5, roleSlug: "viewer" },
            { teamId: 6, roleSlug: "editor" },
        ]);
        assert.strictEqual(actor.activeTeamId, 5);
    });

    test("isSuperadmin is coerced to a boolean and a user with no memberships is valid", () => {
        const actor = buildActor({ userId: 1, isSuperadmin: 1 }, []);
        assert.strictEqual(actor.isSuperadmin, true);
        assert.strictEqual(actor.memberships.size, 0);
        assert.strictEqual(actor.activeTeamId, null);
    });
});

// -------------------------------------------------------------------------
// can() / requirePermission() / authorizeResource() — enforcement ON
// -------------------------------------------------------------------------
describe("authorization with enforcement ON", () => {
    before(() => setEnforcementEnabled(true));
    after(() => setEnforcementEnabled(false));

    const viewer = buildActor({ userId: 10, isSuperadmin: false }, [{ teamId: 1, roleSlug: "viewer" }], 1);
    const editor = buildActor({ userId: 11, isSuperadmin: false }, [{ teamId: 1, roleSlug: "editor" }], 1);
    const superadmin = buildActor({ userId: 1, isSuperadmin: true }, []);

    test("enforcement flag reports as on", () => {
        assert.strictEqual(isEnforcementEnabled(), true);
    });

    test("viewer may read but not create within its team", () => {
        assert.strictEqual(can(viewer, "monitor:read", { teamId: 1 }), true);
        assert.strictEqual(can(viewer, "monitor:create", { teamId: 1 }), false);
    });

    test("editor may create within its team", () => {
        assert.strictEqual(can(editor, "monitor:create", { teamId: 1 }), true);
    });

    test("a member of team 1 cannot act on a resource owned by team 2 (tenant isolation)", () => {
        assert.strictEqual(can(editor, "monitor:read", { teamId: 2 }), false);
        assert.strictEqual(can(editor, "monitor:update", { teamId: 2 }), false);
    });

    test("team-scoped check without a resolved teamId is denied (never assumes)", () => {
        assert.strictEqual(can(editor, "monitor:read", {}), false);
        assert.strictEqual(can(editor, "monitor:read", undefined), false);
        assert.strictEqual(can(editor, "monitor:read", { teamId: null }), false);
    });

    test("super admin bypasses every check, even with no memberships", () => {
        assert.strictEqual(can(superadmin, "monitor:delete", { teamId: 999 }), true);
        assert.strictEqual(can(superadmin, "user:manage", {}), true);
        assert.strictEqual(can(superadmin, "team:create", {}), true);
    });

    test("global action user:manage is denied to non-superadmins, allowed to superadmin", () => {
        assert.strictEqual(can(editor, "user:manage", {}), false);
        assert.strictEqual(can(superadmin, "user:manage", {}), true);
    });

    test("can() throws on an unknown action while enforcing", () => {
        assert.throws(() => can(editor, "monitor:destroy", { teamId: 1 }), /Unknown permission action/);
    });

    test("requirePermission throws ForbiddenError when denied and is silent when allowed", () => {
        assert.throws(() => requirePermission(viewer, "monitor:create", { teamId: 1 }), ForbiddenError);
        assert.doesNotThrow(() => requirePermission(viewer, "monitor:read", { teamId: 1 }));
    });

    test("authorizeResource resolves the team via the loader, ignoring any client-supplied teamId", async () => {
        // The loader is the single source of truth for the owning team. Even
        // though we never pass the resource's real team to authorizeResource,
        // it resolves it from the id and authorizes correctly.
        const calls = [];
        const loaderTeam1 = async (type, id) => {
            calls.push([type, id]);
            return 1;
        };
        const loaderTeam2 = async () => 2;

        assert.strictEqual(await authorizeResource(editor, "monitor:update", "monitor", 55, loaderTeam1), true);
        assert.deepStrictEqual(calls, [["monitor", 55]], "loader must be called with (resourceType, resourceId)");

        // Same actor, resource actually owned by team 2 -> denied.
        assert.strictEqual(await authorizeResource(editor, "monitor:update", "monitor", 77, loaderTeam2), false);
    });

    test("authorizeResource denies when the loader cannot resolve a team", async () => {
        const nullLoader = async () => null;
        assert.strictEqual(await authorizeResource(editor, "monitor:read", "monitor", 1, nullLoader), false);
    });

    test("requireResource throws ForbiddenError when denied and resolves silently when allowed", async () => {
        const loaderTeam1 = async () => 1;
        const loaderTeam2 = async () => 2;
        await assert.doesNotReject(requireResource(editor, "monitor:read", "monitor", 1, loaderTeam1));
        await assert.rejects(requireResource(viewer, "monitor:create", "monitor", 1, loaderTeam1), ForbiddenError);
        await assert.rejects(requireResource(editor, "monitor:read", "monitor", 1, loaderTeam2), ForbiddenError);
    });
});

// -------------------------------------------------------------------------
// scopeFilter — enforcement ON
// -------------------------------------------------------------------------
describe("scopeFilter with enforcement ON", () => {
    before(() => setEnforcementEnabled(true));
    after(() => setEnforcementEnabled(false));

    test("super admin sees everything", () => {
        const superadmin = buildActor({ userId: 1, isSuperadmin: true }, []);
        assert.deepStrictEqual(scopeFilter(superadmin), { clause: "1 = 1", params: [] });
    });

    test("a member is restricted to their team ids", () => {
        const actor = buildActor({ userId: 2, isSuperadmin: false }, [
            { teamId: 4, roleSlug: "viewer" },
            { teamId: 8, roleSlug: "editor" },
        ]);
        const filter = scopeFilter(actor);
        assert.strictEqual(filter.clause, "team_id IN (?, ?)");
        assert.deepStrictEqual(filter.params, [4, 8]);
    });

    test("a user with no memberships sees nothing", () => {
        const actor = buildActor({ userId: 3, isSuperadmin: false }, []);
        assert.deepStrictEqual(scopeFilter(actor), { clause: "1 = 0", params: [] });
    });

    test("a null/undefined actor sees nothing (fails closed, never throws)", () => {
        assert.deepStrictEqual(scopeFilter(null), { clause: "1 = 0", params: [] });
        assert.deepStrictEqual(scopeFilter(undefined), { clause: "1 = 0", params: [] });
    });

    test("permission filter excludes teams lacking the read permission", () => {
        const actor = buildActor({ userId: 4, isSuperadmin: false }, [
            { teamId: 4, roleSlug: "viewer" },
            { teamId: 8, permissions: [] }, // member but no read grant
        ]);
        const filter = scopeFilter(actor, { permission: "monitor:read" });
        assert.strictEqual(filter.clause, "team_id IN (?)");
        assert.deepStrictEqual(filter.params, [4]);
    });

    test("respects a custom team-id column name", () => {
        const actor = buildActor({ userId: 5, isSuperadmin: false }, [{ teamId: 9, roleSlug: "viewer" }]);
        const filter = scopeFilter(actor, { column: "owner_team_id" });
        assert.strictEqual(filter.clause, "owner_team_id IN (?)");
        assert.deepStrictEqual(filter.params, [9]);
    });
});

// -------------------------------------------------------------------------
// Flag-OFF (dark-launch) contract: behaviour must be byte-identical to legacy.
// -------------------------------------------------------------------------
describe("flag-OFF dark-launch contract", () => {
    before(() => setEnforcementEnabled(false));

    test("enforcement defaults to OFF", () => {
        assert.strictEqual(isEnforcementEnabled(), false);
    });

    test("can() allows everything, including unknown actions and empty actors", () => {
        const nobody = buildActor({ userId: 42, isSuperadmin: false }, []);
        assert.strictEqual(can(nobody, "monitor:delete", { teamId: 999 }), true);
        assert.strictEqual(can(nobody, "user:manage", {}), true);
        // Unknown actions are not even validated while OFF — fully permissive.
        assert.strictEqual(can(nobody, "monitor:destroy", {}), true);
    });

    test("requirePermission never throws while OFF", () => {
        const nobody = buildActor({ userId: 42, isSuperadmin: false }, []);
        assert.doesNotThrow(() => requirePermission(nobody, "monitor:create", { teamId: 999 }));
    });

    test("scopeFilter falls back to the legacy per-user filter", () => {
        const actor = buildActor({ userId: 42, isSuperadmin: false }, [{ teamId: 1, roleSlug: "viewer" }]);
        assert.deepStrictEqual(scopeFilter(actor), { clause: "user_id = ?", params: [42] });
    });

    test("scopeFilter has no superadmin carve-out while OFF -- a superadmin is scoped to their own rows too, since several call sites hand back plaintext secrets with no per-row filtering", () => {
        const superadmin = buildActor({ userId: 1, isSuperadmin: true }, []);
        assert.deepStrictEqual(scopeFilter(superadmin), { clause: "user_id = ?", params: [1] });
    });

    test("scopeFilter never throws on a null/undefined actor, even while OFF", () => {
        assert.deepStrictEqual(scopeFilter(null), { clause: "1 = 0", params: [] });
        assert.deepStrictEqual(scopeFilter(undefined), { clause: "1 = 0", params: [] });
    });

    test("authorizeResource returns true without ever calling the loader", async () => {
        let called = false;
        const loader = async () => {
            called = true;
            return 1;
        };
        const actor = buildActor({ userId: 42, isSuperadmin: false }, []);
        assert.strictEqual(await authorizeResource(actor, "monitor:update", "monitor", 1, loader), true);
        assert.strictEqual(called, false, "loader must not run while enforcement is OFF");
    });

    test("requireResource never throws and never calls the loader while OFF", async () => {
        let called = false;
        const loader = async () => {
            called = true;
            return 1;
        };
        const actor = buildActor({ userId: 42, isSuperadmin: false }, []);
        await assert.doesNotReject(requireResource(actor, "monitor:delete", "monitor", 1, loader));
        assert.strictEqual(called, false, "loader must not run while enforcement is OFF");
    });
});
