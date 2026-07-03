const { R } = require("redbean-node");

/**
 * Resolve a stat bean for the given table/monitor/timestamp, reusing a cached bean when it matches.
 *
 * Mirrors the original per-table getDailyStatBean/getHourlyStatBean/getMinutelyStatBean logic:
 * if the cached bean matches the requested timestamp it is returned as-is, otherwise the bean is
 * looked up and a fresh one is dispensed when none exists.
 * @param {string} table The stat table name (e.g. "stat_daily")
 * @param {number} monitorID the id of the monitor
 * @param {number} timestamp milliseconds
 * @param {?import("redbean-node").Bean} cachedBean The most recently used bean for this table, or null
 * @returns {Promise<import("redbean-node").Bean>} stat bean
 */
async function findOrDispenseStatBean(table, monitorID, timestamp, cachedBean) {
    if (cachedBean && cachedBean.timestamp === timestamp) {
        return cachedBean;
    }

    let bean = await R.findOne(table, " monitor_id = ? AND timestamp = ?", [monitorID, timestamp]);

    if (!bean) {
        bean = R.dispense(table);
        bean.monitor_id = monitorID;
        bean.timestamp = timestamp;
    }

    return bean;
}

module.exports = {
    findOrDispenseStatBean,
};
