const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");
const dayjs = require("dayjs");
const { resolveTeamIdForCreate } = require("../security/actor-repository");

class APIKey extends BeanModel {
    /**
     * Get the current status of this API key
     * @returns {string} active, inactive or expired
     */
    getStatus() {
        let current = dayjs();
        let expiry = dayjs(this.expires);
        if (expiry.diff(current) < 0) {
            return "expired";
        }

        return this.active ? "active" : "inactive";
    }

    /**
     * Returns an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            id: this.id,
            key: this.key,
            name: this.name,
            userID: this.user_id,
            createdDate: this.created_date,
            active: this.active,
            expires: this.expires,
            status: this.getStatus(),
        };
    }

    /**
     * Returns an object that ready to parse to JSON with sensitive fields
     * removed
     * @returns {object} Object ready to parse
     */
    toPublicJSON() {
        return {
            id: this.id,
            name: this.name,
            userID: this.user_id,
            createdDate: this.created_date,
            active: this.active,
            expires: this.expires,
            status: this.getStatus(),
        };
    }

    /**
     * Create a new API Key and store it in the database. The key is always
     * created with the read-only "viewer" role -- matching how a legacy
     * (pre-RBAC) key is downgraded on migration -- rather than inheriting the
     * creator's own role, since there's no UI yet to choose a role and an API
     * key must never be more privileged than explicitly intended (ADR-0010 R2:
     * an API key actor never short-circuits is_superadmin, even indirectly).
     * @param {object} key Object sent by client
     * @param {int} userID ID of socket user
     * @param {import("../security/authz").Actor} actor RBAC actor creating the key
     * @returns {Promise<bean>} API key
     */
    static async save(key, userID, actor) {
        let bean;
        bean = R.dispense("api_key");

        bean.key = key.key;
        bean.name = key.name;
        bean.user_id = userID;
        bean.active = key.active;
        bean.expires = key.expires;
        bean.team_id = await resolveTeamIdForCreate(actor);

        const viewerRole = await R.findOne("role", "slug = ? AND team_id IS NULL AND is_system = 1", ["viewer"]);
        bean.role_id = viewerRole ? viewerRole.id : null;

        await R.store(bean);

        return bean;
    }
}

module.exports = APIKey;
