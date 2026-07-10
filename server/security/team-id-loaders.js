/**
 * Generic `team_id` loader for {@link module:server/security/authz}'s
 * `requireResource`/`authorizeResource`. One shared implementation for every
 * team-scoped resource table, keyed by the resource type strings used in the
 * permission catalog (ADR-0010, phase P3).
 */

const { R } = require("redbean-node");

/**
 * Resource type -> backing table name. Kept as an explicit allowlist so a
 * typo/unknown resource type fails loudly instead of building a query from
 * unchecked input.
 * @type {Record<string, string>}
 */
const TABLE_BY_RESOURCE_TYPE = {
    monitor: "monitor",
    maintenance: "maintenance",
    notification: "notification",
    proxy: "proxy",
    docker_host: "docker_host",
    remote_browser: "remote_browser",
    remote_instance: "remote_instance",
    api_key: "api_key",
    tag: "tag",
    status_page: "status_page",
    notification_route: "notification_route",
    dashboard: "dashboard",
};

/**
 * Load the `team_id` of a row given its resource type and id. Matches the
 * `(resourceType, resourceId) => teamId|null` signature `authorizeResource`/
 * `requireResource` expect.
 * @param {string} resourceType One of the keys in {@link TABLE_BY_RESOURCE_TYPE}.
 * @param {number} resourceId The row id to resolve.
 * @returns {Promise<number|null>} The row's team_id, or null if not found.
 * @throws {Error} If resourceType is not a known, allowlisted resource type.
 */
async function teamIdLoader(resourceType, resourceId) {
    const table = TABLE_BY_RESOURCE_TYPE[resourceType];
    if (!table) {
        throw new Error(`No team_id loader for resource type: ${resourceType}`);
    }
    const value = await R.getCell(`SELECT team_id FROM \`${table}\` WHERE id = ?`, [resourceId]);
    return value === undefined || value === null ? null : value;
}

module.exports = { teamIdLoader, TABLE_BY_RESOURCE_TYPE };
