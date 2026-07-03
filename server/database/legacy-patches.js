/**
 * SQLite only
 * Legacy list of SQL patch files applied by the old (pre-knex-migration) patching process.
 * Add patch filename in key
 * Values:
 *      true: Add it regardless of order
 *      false: Do nothing
 *      { parents: []}: Need parents before add it
 * @deprecated
 * @type {object}
 */
const patchList = {
    "patch-setting-value-type.sql": true,
    "patch-improve-performance.sql": true,
    "patch-2fa.sql": true,
    "patch-add-retry-interval-monitor.sql": true,
    "patch-incident-table.sql": true,
    "patch-group-table.sql": true,
    "patch-monitor-push_token.sql": true,
    "patch-http-monitor-method-body-and-headers.sql": true,
    "patch-2fa-invalidate-used-token.sql": true,
    "patch-notification_sent_history.sql": true,
    "patch-monitor-basic-auth.sql": true,
    "patch-add-docker-columns.sql": true,
    "patch-status-page.sql": true,
    "patch-proxy.sql": true,
    "patch-monitor-expiry-notification.sql": true,
    "patch-status-page-footer-css.sql": true,
    "patch-added-mqtt-monitor.sql": true,
    "patch-add-clickable-status-page-link.sql": true,
    "patch-add-sqlserver-monitor.sql": true,
    "patch-add-other-auth.sql": { parents: ["patch-monitor-basic-auth.sql"] },
    "patch-grpc-monitor.sql": true,
    "patch-add-radius-monitor.sql": true,
    "patch-monitor-add-resend-interval.sql": true,
    "patch-ping-packet-size.sql": true,
    "patch-maintenance-table2.sql": true,
    "patch-add-gamedig-monitor.sql": true,
    "patch-add-google-analytics-status-page-tag.sql": true,
    "patch-http-body-encoding.sql": true,
    "patch-add-description-monitor.sql": true,
    "patch-api-key-table.sql": true,
    "patch-monitor-tls.sql": true,
    "patch-maintenance-cron.sql": true,
    "patch-add-parent-monitor.sql": true,
    "patch-add-invert-keyword.sql": true,
    "patch-added-json-query.sql": true,
    "patch-added-kafka-producer.sql": true,
    "patch-add-certificate-expiry-status-page.sql": true,
    "patch-monitor-oauth-cc.sql": true,
    "patch-add-timeout-monitor.sql": true,
    "patch-add-gamedig-given-port.sql": true,
    "patch-notification-config.sql": true,
    "patch-fix-kafka-producer-booleans.sql": true,
    "patch-timeout.sql": true,
    "patch-monitor-tls-info-add-fk.sql": true, // The last file so far converted to a knex migration file
};

module.exports = {
    patchList,
};
