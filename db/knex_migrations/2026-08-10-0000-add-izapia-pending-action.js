/**
 * Migration: IZAPIA interactive-button pending actions (PR #91).
 *
 * On personal/QR-paired WhatsApp sessions (as opposed to the official
 * WhatsApp Business Cloud API), tapping an IZAPIA "interactive" button does
 * NOT come back as a structured `message.interactiveReply` event with the
 * button's `id` -- confirmed live against a real IZAPIA session during this
 * PR's manual testing. Instead, WhatsApp's own client sends an ordinary
 * `message.received` text reply (the button's label) that quotes the
 * original message via `contextInfo.stanzaID`.
 *
 * This table records, at send time, which outbound message id corresponds
 * to which monitor/notification/action, so the webhook handler
 * (server/routers/izapia-callback-router.js) can look the row up by the
 * incoming reply's quoted stanzaID and recover which button was actually
 * clicked. Rows are short-lived (one per alert actually sent with
 * interactive buttons); `created_date` lets a future cleanup job prune old
 * ones, though none exists yet -- the table is expected to stay small.
 */

/**
 * Apply the izapia_pending_action table.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasTable("izapia_pending_action"))) {
        await knex.schema.createTable("izapia_pending_action", (table) => {
            table.increments("id");
            table.string("message_id", 255).notNullable().index();
            table
                .integer("monitor_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("monitor")
                .onDelete("CASCADE");
            table
                .integer("notification_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("notification")
                .onDelete("CASCADE");
            table.datetime("created_date").defaultTo(knex.fn.now());
        });
    }
};

/**
 * Revert: drop izapia_pending_action.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
    if (await knex.schema.hasTable("izapia_pending_action")) {
        await knex.schema.dropTable("izapia_pending_action");
    }
};
