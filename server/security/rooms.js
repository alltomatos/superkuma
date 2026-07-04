/**
 * Socket.io room-naming helper for the Teams + RBAC retrofit (ADR-0010, phase
 * P4). Every place that currently does `socket.join(userID)` /
 * `io.to(userID).emit(...)` should route through {@link roomFor} instead.
 *
 * While enforcement is OFF, `roomFor` returns the exact legacy room name
 * (the numeric user id, coerced to a string -- Socket.io room names are
 * always strings internally, so this matches today's behaviour exactly).
 * Once enforcement is ON, it returns a team-scoped room so every member of a
 * team receives the same real-time updates, not just the original owning
 * user's own browser tabs.
 */

const { isEnforcementEnabled } = require("./authz");

/**
 * Resolve the Socket.io room name to join/address for a given user + team.
 * @param {number} userId The legacy per-user room identity.
 * @param {number|null} teamId The resource/actor's team id (used only when enforcement is ON).
 * @returns {string} The room name to join or emit to.
 */
function roomFor(userId, teamId) {
    if (!isEnforcementEnabled()) {
        return String(userId);
    }
    return "team:" + teamId;
}

module.exports = { roomFor };
