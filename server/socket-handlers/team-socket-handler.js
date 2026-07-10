const { checkLogin } = require("../util-server");
const { log, genSecret } = require("../../src/util");
const { R } = require("redbean-node");
const { requirePermission, ForbiddenError } = require("../security/authz");
const { z } = require("zod");
const { validate } = require("../validation");

// The non-superadmin built-in roles a team member can be assigned. "superadmin"
// is deliberately excluded here -- that's a separate, global, user-level flag
// (see setUserSuperadmin in user-socket-handler.js), not a per-team role, and
// exposing it as an assignable team role would create two different, ambiguous
// ways to grant the same cross-instance power.
const ASSIGNABLE_ROLE_SLUGS = ["owner", "admin", "editor", "viewer"];

const createTeamSchema = z.object({
    name: z.string().trim().min(1).max(255),
});

const teamIdSchema = z.object({
    teamId: z.number().int().positive(),
});

const addTeamMemberSchema = z.object({
    teamId: z.number().int().positive(),
    userId: z.number().int().positive(),
    roleSlug: z.enum(ASSIGNABLE_ROLE_SLUGS),
});

const removeTeamMemberSchema = z.object({
    teamId: z.number().int().positive(),
    userId: z.number().int().positive(),
});

/**
 * Turn a team display name into a URL/identifier-safe, lowercase slug
 * (ASCII alphanumerics and hyphens only, no leading/trailing/duplicate
 * hyphens). Uniqueness is enforced by the DB, not here.
 * @param {string} name Team display name
 * @returns {string} The derived slug
 */
function slugify(name) {
    return (
        name
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "") // strip combining diacritics left by NFKD (e.g. "ã" -> "a" + combining tilde)
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "team"
    );
}

/**
 * Whether a user is currently flagged as a global superadmin. Always re-reads
 * the DB rather than trusting the cached socket.actor.isSuperadmin, which can
 * go stale if the caller was demoted on a still-open connection (the same
 * reasoning setUserSuperadmin's own caller check uses).
 * @param {number} userId The user id to check
 * @returns {Promise<boolean>} True if the user is an active superadmin
 */
async function isSuperadmin(userId) {
    const caller = await R.findOne("user", "id = ?", [userId]);
    return !!(caller && caller.is_superadmin);
}

/**
 * Refuse team-management actions (create team, add/remove member, change a
 * member's role) to a non-superadmin actor. This is intentionally stricter
 * than the permission catalog alone for "team:member_manage" (which owner/
 * admin roles are also granted, per ADR-0010) -- self-service team
 * membership management by non-superadmin roles is a deliberate future
 * expansion, not yet exposed. This explicit, DB-refreshed check is today's
 * real gate for every team-management action.
 * @param {Socket} socket Socket.io instance
 * @returns {Promise<void>}
 * @throws {ForbiddenError} If the caller is not currently a superadmin
 */
async function assertCallerIsSuperadmin(socket) {
    if (!(await isSuperadmin(socket.userID))) {
        throw new ForbiddenError("Only a superadmin can manage teams.");
    }
}

/**
 * Refuse to let a caller read a team's details/members unless they are
 * either a superadmin or themselves a member of that team. Unlike the
 * management actions above, plain team members are meant to be able to see
 * their own team's roster -- just not every other team's.
 * @param {Socket} socket Socket.io instance
 * @param {number} teamId The team being read
 * @returns {Promise<void>}
 * @throws {ForbiddenError} If the caller may not read this team
 */
async function assertCanReadTeam(socket, teamId) {
    if (await isSuperadmin(socket.userID)) {
        return;
    }
    const membership = await R.findOne("team_user", "team_id = ? AND user_id = ?", [teamId, socket.userID]);
    if (!membership) {
        throw new ForbiddenError("You are not a member of this team.");
    }
}

/**
 * Handlers for team management (create teams, add/remove members, assign roles).
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.teamSocketHandler = (socket) => {
    // List teams. A superadmin sees every team; anyone else sees only the
    // teams they're a member of.
    socket.on("getTeamList", async (callback) => {
        try {
            checkLogin(socket);

            // hasOtelIngestToken is a presence boolean only (ADR-0015) -- never
            // the token value itself, which this list is never trusted to carry.
            // The cleartext token is only ever returned once, directly from
            // regenerateOtelIngestToken's own response below.
            const list = (await isSuperadmin(socket.userID))
                ? await R.getAll(
                      "SELECT id, name, slug, active, (otel_ingest_token IS NOT NULL) AS hasOtelIngestToken FROM team ORDER BY name"
                  )
                : await R.getAll(
                      `SELECT t.id, t.name, t.slug, t.active, (t.otel_ingest_token IS NOT NULL) AS hasOtelIngestToken
                       FROM team t
                       JOIN team_user tu ON tu.team_id = t.id
                       WHERE tu.user_id = ?
                       ORDER BY t.name`,
                      [socket.userID]
                  );

            callback({
                ok: true,
                teamList: list,
            });
        } catch (e) {
            log.error("team", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // List a team's members. Restricted to that team's own members and
    // superadmins -- otherwise any authenticated user could read any other
    // team's roster (usernames, emails, roles) just by guessing a teamId.
    socket.on("getTeamMembers", async (input, callback) => {
        try {
            checkLogin(socket);

            const { teamId } = validate(teamIdSchema, input);
            requirePermission(socket.actor, "team:read", { teamId });
            await assertCanReadTeam(socket, teamId);

            const members = await R.getAll(
                `SELECT u.id, u.username, u.email, r.slug AS roleSlug, r.name AS roleName
                 FROM team_user tu
                 JOIN user u ON u.id = tu.user_id
                 JOIN role r ON r.id = tu.role_id
                 WHERE tu.team_id = ?
                 ORDER BY u.username`,
                [teamId]
            );

            callback({
                ok: true,
                members,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
                msgi18n: !!e.msgi18n,
            });
        }
    });

    // Create a new team. Global action (team:create is not team-scoped, and
    // only the superadmin built-in role grants it) -- gated on the caller
    // actually being a superadmin right now, not just holding a cached flag.
    socket.on("createTeam", async (input, callback) => {
        try {
            checkLogin(socket);
            requirePermission(socket.actor, "team:create", {});
            await assertCallerIsSuperadmin(socket);

            const { name } = validate(createTeamSchema, input);

            let team = R.dispense("team");
            team.name = name;
            team.slug = slugify(name);
            team.is_system = false;
            team.active = true;
            team.created_by = socket.userID;

            try {
                await R.store(team);
            } catch (e) {
                throw new Error("A team with this name already exists.");
            }

            log.debug("team", `Created team: ${team.id} (${team.slug})`);

            callback({
                ok: true,
                msg: "teamCreated",
                msgi18n: true,
                teamId: team.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
                msgi18n: !!e.msgi18n,
            });
        }
    });

    // Add a user to a team with a role, or change their existing role in that
    // team (upsert on the team_id+user_id unique pair).
    socket.on("addTeamMember", async (input, callback) => {
        try {
            checkLogin(socket);

            const { teamId, userId, roleSlug } = validate(addTeamMemberSchema, input);

            requirePermission(socket.actor, "team:member_manage", { teamId });
            await assertCallerIsSuperadmin(socket);

            const team = await R.findOne("team", "id = ?", [teamId]);
            if (!team) {
                throw new Error("Team not found.");
            }
            const user = await R.findOne("user", "id = ?", [userId]);
            if (!user) {
                throw new Error("User not found.");
            }
            const role = await R.findOne("role", "slug = ? AND team_id IS NULL AND is_system = 1", [roleSlug]);
            if (!role) {
                throw new Error("Role not found.");
            }

            let membership = await R.findOne("team_user", "team_id = ? AND user_id = ?", [teamId, userId]);
            const isNewMembership = !membership;
            if (!membership) {
                membership = R.dispense("team_user");
                membership.team_id = teamId;
                membership.user_id = userId;
            }
            membership.role_id = role.id;

            try {
                await R.store(membership);
            } catch (e) {
                throw new Error("This member's role was just changed by another request. Please try again.");
            }

            log.debug("team", `Team ${teamId}: user ${userId} set to role "${roleSlug}"`);

            callback({
                ok: true,
                msg: isNewMembership ? "teamMemberAdded" : "teamMemberRoleUpdated",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
                msgi18n: !!e.msgi18n,
            });
        }
    });

    // Remove a user from a team. Not guarded by a "last owner of this team"
    // check the way setUserSuperadmin guards the last superadmin: this action
    // is already superadmin-only, and a superadmin retains full access to
    // every team regardless of membership, so an owner-less team is still
    // manageable. (A user left with zero team memberships anywhere is instead
    // handled defensively where it actually matters -- see the team_id
    // fallback in monitor-socket-handler.js's "add" handler -- rather than by
    // blocking removal here, since a team-membership invariant enforced only
    // in this one handler wouldn't cover every future way a membership could
    // be dropped.)
    socket.on("removeTeamMember", async (input, callback) => {
        try {
            checkLogin(socket);

            const { teamId, userId } = validate(removeTeamMemberSchema, input);

            requirePermission(socket.actor, "team:member_manage", { teamId });
            await assertCallerIsSuperadmin(socket);

            await R.exec("DELETE FROM team_user WHERE team_id = ? AND user_id = ?", [teamId, userId]);

            log.debug("team", `Team ${teamId}: removed user ${userId}`);

            callback({
                ok: true,
                msg: "teamMemberRemoved",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
                msgi18n: !!e.msgi18n,
            });
        }
    });

    // Generate (or replace) a team's OTLP telemetry ingest token (ADR-0015,
    // TASK-A2-5). Unlike PushUrlField's client-side genSecret() convention for
    // a per-monitor push token (a value the client picks once, and the server
    // merely stores as-is), a team-wide ingest credential is more sensitive --
    // it authenticates every otel monitor's telemetry for the whole team, not
    // just one monitor's push URL -- so it is generated SERVER-SIDE only. The
    // caller never supplies or influences the token's value; the cleartext is
    // returned in this response and never again afterward (getTeamList only
    // ever exposes a hasOtelIngestToken presence boolean, never the value).
    socket.on("regenerateOtelIngestToken", async (input, callback) => {
        try {
            checkLogin(socket);

            const { teamId } = validate(teamIdSchema, input);

            requirePermission(socket.actor, "team:manage", { teamId });
            await assertCallerIsSuperadmin(socket);

            const team = await R.findOne("team", "id = ?", [teamId]);
            if (!team) {
                throw new Error("Team not found.");
            }

            // 64 chars to exactly fill the otel_ingest_token column's width
            // (db/knex_migrations/2026-07-10-0002-add-otel-telemetry-receiver.js).
            const token = genSecret(64);
            team.otel_ingest_token = token;
            await R.store(team);

            log.debug("team", `Team ${teamId}: regenerated OTLP ingest token`);

            callback({
                ok: true,
                msg: "otelIngestTokenRegenerated",
                msgi18n: true,
                token,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
                msgi18n: !!e.msgi18n,
            });
        }
    });
};
