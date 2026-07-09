/**
 * Socket.io room-naming helper for the Teams + RBAC model (ADR-0010). Every
 * place that joins/addresses a user's browser tabs should route through
 * {@link roomFor} instead of `socket.join(userID)` / `io.to(userID).emit(...)`.
 *
 * Returns a team-scoped room so every member of a team receives the same
 * real-time updates, not just the original owning user's own browser tabs.
 * Falls back to the legacy per-user room (the numeric user id, coerced to a
 * string -- Socket.io room names are always strings internally) when no team
 * id is resolvable -- e.g. a user with no team membership yet -- so such an
 * actor gets a private room of their own rather than colliding with every
 * other teamless actor in a single shared "team:null"/"team:undefined" room.
 */

/**
 * Resolve the Socket.io room name to join/address for a given user + team.
 * @param {number} userId The legacy per-user room identity, used as a fallback.
 * @param {number|null} teamId The resource/actor's team id.
 * @returns {string} The room name to join or emit to.
 */
function roomFor(userId, teamId) {
    if (teamId === null || teamId === undefined) {
        return String(userId);
    }
    return "team:" + teamId;
}

module.exports = { roomFor };
