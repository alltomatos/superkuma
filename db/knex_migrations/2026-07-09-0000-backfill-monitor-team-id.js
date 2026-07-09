/**
 * Migration: backfill orphaned monitors into the Default Team (ADR-0010 follow-up).
 *
 * The original RBAC migration (2026-07-04-0000-create-rbac-schema.js) backfilled
 * every monitor that existed at that time into the Default Team, but the "add
 * monitor" socket handler didn't actually start setting team_id on new monitors
 * until now -- so any monitor created between that migration and this fix has
 * team_id = NULL. Re-run the same one-line backfill for any monitor still
 * missing a team_id; idempotent (only touches NULLs), dark-launch (no behaviour
 * change while rbacEnforced stays off).
 */

/**
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    const defaultTeam = await knex("team").where("slug", "default").first();
    if (!defaultTeam) {
        // No RBAC schema/Default Team on this install (shouldn't happen since
        // this migration runs after 2026-07-04-0000, but fail soft rather than
        // block startup on an unrelated install shape).
        return;
    }
    await knex("monitor").whereNull("team_id").update({ team_id: defaultTeam.id });
};

/**
 * @returns {Promise<void>}
 */
exports.down = async function () {
    // Not reversible: we can't distinguish monitors that were genuinely
    // orphaned (pre-fix) from ones legitimately backfilled by the original
    // RBAC migration. No-op, matching the additive/dark-launch nature of the
    // rest of the RBAC rollout.
};
