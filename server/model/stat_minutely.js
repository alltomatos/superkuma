const { BeanModel } = require("redbean-node/dist/bean-model");

class StatMinutely extends BeanModel {
    /**
     * Return an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            id: this.id,
            monitorId: this.monitor_id,
            timestamp: this.timestamp,
            ping: this.ping,
            pingMin: this.ping_min,
            pingMax: this.ping_max,
            up: this.up,
            down: this.down,
            extras: this.extras ? JSON.parse(this.extras) : null,
        };
    }
}

module.exports = StatMinutely;
