const { BeanModel } = require("redbean-node/dist/bean-model");

class RemoteInstance extends BeanModel {
    /**
     * Return an object that ready to parse to JSON
     * Never expose token_hash here.
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            id: this.id,
            instanceId: this.instance_id,
            name: this.name,
            lastSeen: this.last_seen,
            active: this.active,
        };
    }
}

module.exports = RemoteInstance;
