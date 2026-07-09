/**
 * Migration: fix the "rbacEnforced" setting's stored type (ADR-0010 follow-up).
 *
 * The original RBAC migration (2026-07-04-0000-create-rbac-schema.js) seeded
 * this row with type: "boolean". But the only write path that can ever
 * actually toggle it -- the generic setSettings("general", data) socket
 * handler in server/server.js -- only persists a key whose EXISTING stored
 * type matches the type being saved under ("general"); see
 * server/settings.js's setSettings(). Since "boolean" !== "general", every
 * attempt to turn enforcement on or off through that flow was silently
 * dropped: the in-memory flag updated immediately (so it looked like it
 * worked), but reverted to whatever was last actually persisted the next
 * time the process restarted, with no error surfaced anywhere.
 *
 * Fix: retype the existing row to "general" so it's actually writable
 * through the real save path. Idempotent (only touches rows still typed
 * "boolean"); the value itself (true/false) is left untouched.
 */

/**
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    await knex("setting").where("key", "rbacEnforced").andWhere("type", "boolean").update({ type: "general" });
};

/**
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
    await knex("setting").where("key", "rbacEnforced").andWhere("type", "general").update({ type: "boolean" });
};
