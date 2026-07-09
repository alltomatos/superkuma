const { R } = require("redbean-node");
const { requireResource, requirePermission } = require("./security/authz");
const { teamIdLoader } = require("./security/team-id-loaders");
const { resolveTeamIdForCreate } = require("./security/actor-repository");

class RemoteBrowser {
    /**
     * Gets remote browser from ID
     * @param {number} remoteBrowserID ID of the remote browser
     * @param {number} userID ID of the user who created the remote browser
     * @param {import("./security/authz").Actor} actor The acting actor (ADR-0010)
     * @returns {Promise<Bean>} Remote Browser
     */
    static async get(remoteBrowserID, userID, actor) {
        await requireResource(actor, "remote_browser:read", "remote_browser", remoteBrowserID, teamIdLoader);

        let bean = await R.findOne("remote_browser", " id = ? AND user_id = ? ", [remoteBrowserID, userID]);

        if (!bean) {
            throw new Error("Remote browser not found");
        }

        return bean;
    }

    /**
     * Save a Remote Browser
     * @param {object} remoteBrowser Remote Browser to save
     * @param {?number} remoteBrowserID ID of the Remote Browser to update
     * @param {number} userID ID of the user who adds the Remote Browser
     * @param {import("./security/authz").Actor} actor The acting actor (ADR-0010)
     * @returns {Promise<Bean>} Updated Remote Browser
     */
    static async save(remoteBrowser, remoteBrowserID, userID, actor) {
        let bean;

        if (remoteBrowserID) {
            await requireResource(actor, "remote_browser:manage", "remote_browser", remoteBrowserID, teamIdLoader);

            bean = await R.findOne("remote_browser", " id = ? AND user_id = ? ", [remoteBrowserID, userID]);

            if (!bean) {
                throw new Error("Remote browser not found");
            }
        } else {
            requirePermission(actor, "remote_browser:manage", { teamId: actor ? actor.activeTeamId : null });
            bean = R.dispense("remote_browser");
            bean.team_id = await resolveTeamIdForCreate(actor);
        }

        bean.user_id = userID;
        bean.name = remoteBrowser.name;
        bean.url = remoteBrowser.url;

        await R.store(bean);

        return bean;
    }

    /**
     * Delete a Remote Browser
     * @param {number} remoteBrowserID ID of the Remote Browser to delete
     * @param {number} userID ID of the user who created the Remote Browser
     * @param {import("./security/authz").Actor} actor The acting actor (ADR-0010)
     * @returns {Promise<void>}
     */
    static async delete(remoteBrowserID, userID, actor) {
        await requireResource(actor, "remote_browser:manage", "remote_browser", remoteBrowserID, teamIdLoader);

        let bean = await R.findOne("remote_browser", " id = ? AND user_id = ? ", [remoteBrowserID, userID]);

        if (!bean) {
            throw new Error("Remote Browser not found");
        }

        // Delete removed remote browser from monitors if exists
        await R.exec("UPDATE monitor SET remote_browser = null WHERE remote_browser = ?", [remoteBrowserID]);

        await R.trash(bean);
    }
}

module.exports = {
    RemoteBrowser,
};
