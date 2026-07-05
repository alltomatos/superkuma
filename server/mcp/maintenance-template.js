/**
 * Maintenance payload template and builder.
 *
 * The server's `addMaintenance` / `editMaintenance` handlers feed the payload
 * through `Maintenance.jsonToBean`, which always reads `dateRange`, `timeRange`,
 * `weekdays`, `daysOfMonth` and the strategy-specific fields. We start from a
 * base of sane defaults (mirroring EditMaintenance.vue) and overlay only the
 * fields the agent supplied; the server's jsonToBean/validateCron remain the
 * authoritative gate.
 */

/**
 * Default maintenance payload. Defaults to the "manual" strategy (toggled on/off
 * by hand), which needs no date/time window — the safest default for an agent.
 * @type {object}
 */
const MAINTENANCE_DEFAULTS = {
    title: "",
    description: "",
    strategy: "manual",
    active: true,
    cron: "30 3 * * *",
    durationMinutes: 60,
    intervalDay: 1,
    dateRange: [null, null],
    timeRange: [
        { hours: 2, minutes: 0 },
        { hours: 3, minutes: 0 },
    ],
    weekdays: [],
    daysOfMonth: [],
    timezoneOption: "SAME_AS_SERVER",
};

/**
 * Convert an "HH:mm" string into the { hours, minutes } object the server wants.
 * @param {string} value Time string like "02:30".
 * @returns {object} The parsed { hours, minutes }.
 */
function parseTime(value) {
    const parts = String(value).split(":");
    return {
        hours: parseInt(parts[0], 10) || 0,
        minutes: parseInt(parts[1], 10) || 0,
    };
}

/**
 * Build a complete maintenance payload by overlaying agent input onto a base
 * (defaults for create, the fetched maintenance for update).
 * @param {object} base Base maintenance object; cloned, never mutated.
 * @param {object} input Agent-supplied fields (see the tool input schema).
 * @returns {object} A complete payload for addMaintenance/editMaintenance.
 */
function buildMaintenancePayload(base, input) {
    const m = { ...base };

    for (const key of ["title", "description", "strategy", "active", "cron", "durationMinutes", "intervalDay"]) {
        if (input[key] !== undefined) {
            m[key] = input[key];
        }
    }

    if (input.timezone !== undefined) {
        m.timezoneOption = input.timezone;
    }

    if (input.weekdays !== undefined) {
        m.weekdays = input.weekdays;
    }

    if (input.daysOfMonth !== undefined) {
        m.daysOfMonth = input.daysOfMonth;
    }

    if (input.startDateTime !== undefined || input.endDateTime !== undefined) {
        const cur = Array.isArray(m.dateRange) ? m.dateRange : [null, null];
        m.dateRange = [
            input.startDateTime !== undefined ? input.startDateTime : (cur[0] ?? null),
            input.endDateTime !== undefined ? input.endDateTime : (cur[1] ?? null),
        ];
    }

    if (input.startTime !== undefined || input.endTime !== undefined) {
        const cur = Array.isArray(m.timeRange) ? m.timeRange : MAINTENANCE_DEFAULTS.timeRange;
        m.timeRange = [
            input.startTime !== undefined ? parseTime(input.startTime) : cur[0],
            input.endTime !== undefined ? parseTime(input.endTime) : cur[1],
        ];
    }

    return m;
}

/**
 * Reduce a full maintenance object to a compact summary for list views.
 * @param {object} maintenance A maintenance object from the server.
 * @returns {object} A trimmed summary.
 */
function summarizeMaintenance(maintenance) {
    return {
        id: maintenance.id,
        title: maintenance.title,
        strategy: maintenance.strategy,
        active: Boolean(maintenance.active),
        status: maintenance.status ?? null,
    };
}

module.exports = {
    MAINTENANCE_DEFAULTS,
    buildMaintenancePayload,
    summarizeMaintenance,
};
