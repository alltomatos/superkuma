const { z } = require("zod");
const { registerTool } = require("./helpers");
const { MAINTENANCE_DEFAULTS, buildMaintenancePayload, summarizeMaintenance } = require("../maintenance-template");

const STRATEGIES = ["manual", "single", "recurring-interval", "recurring-weekday", "recurring-day-of-month", "cron"];

/**
 * Zod raw shape shared by create/update maintenance (minus the identity fields).
 * @type {object}
 */
const commonMaintenanceShape = {
    description: z.string().optional().describe("Free-text description"),
    strategy: z.enum(STRATEGIES).optional().describe("Scheduling strategy. Default 'manual' (toggled on/off by hand)"),
    active: z.boolean().optional().describe("Whether the maintenance is active. Default true"),
    startDateTime: z.string().optional().describe("Window start (ISO datetime) for 'single' strategy"),
    endDateTime: z.string().optional().describe("Window end (ISO datetime) for 'single' strategy"),
    startTime: z.string().optional().describe("Daily start time 'HH:mm' for recurring strategies"),
    endTime: z.string().optional().describe("Daily end time 'HH:mm' for recurring strategies"),
    weekdays: z.array(z.number().int()).optional().describe("Active weekdays (1=Mon..7=Sun) for recurring-weekday"),
    daysOfMonth: z
        .array(z.number().int())
        .optional()
        .describe("Active days of month (1-31) for recurring-day-of-month"),
    cron: z.string().optional().describe("Cron expression for the 'cron' strategy"),
    durationMinutes: z.number().int().min(1).optional().describe("Window duration in minutes for the 'cron' strategy"),
    intervalDay: z.number().int().min(1).optional().describe("Interval in days for recurring-interval"),
    timezone: z.string().optional().describe("Timezone, e.g. 'SAME_AS_SERVER' or 'Europe/London'"),
};

/**
 * Register maintenance MCP tools (read always; create/update/pause/resume when
 * mutations are enabled; delete when deletes are enabled).
 * @param {object} server The McpServer instance.
 * @param {object} client The SuperKumaClient instance.
 * @param {object} config Resolved MCP configuration.
 * @returns {void}
 */
function registerMaintenanceTools(server, client, config) {
    registerTool(server, config, {
        name: "list_maintenances",
        title: "List maintenances",
        description: "List all maintenance windows as summaries (id, title, strategy, active, status).",
        handler: async () => {
            const list = await client.listMaintenances();
            return {
                count: list.length,
                maintenances: list.map(summarizeMaintenance),
            };
        },
    });

    registerTool(server, config, {
        name: "get_maintenance",
        title: "Get maintenance",
        description: "Fetch the full configuration of a maintenance window by id.",
        inputSchema: {
            id: z.number().int().describe("Maintenance id"),
        },
        handler: async (args) => {
            const res = await client.request("getMaintenance", args.id);
            return res.maintenance;
        },
    });

    registerTool(server, config, {
        name: "create_maintenance",
        title: "Create maintenance",
        description:
            "Create a maintenance window. Only 'title' is required; defaults to the 'manual' strategy (active until you pause it). For a one-off window use strategy 'single' with startDateTime/endDateTime.",
        mutation: true,
        inputSchema: {
            title: z.string().min(1).describe("Maintenance title"),
            ...commonMaintenanceShape,
        },
        handler: async (args) => {
            const payload = buildMaintenancePayload(MAINTENANCE_DEFAULTS, args);
            const res = await client.request("addMaintenance", payload);
            return {
                ok: true,
                maintenanceID: res.maintenanceID,
                message: `Created maintenance "${args.title}" (id ${res.maintenanceID}).`,
            };
        },
    });

    registerTool(server, config, {
        name: "update_maintenance",
        title: "Update maintenance",
        description:
            "Update a maintenance window. Fetches the current config and overlays only the fields you provide.",
        mutation: true,
        inputSchema: {
            id: z.number().int().describe("Maintenance id"),
            title: z.string().min(1).optional().describe("Maintenance title"),
            ...commonMaintenanceShape,
        },
        handler: async (args) => {
            const current = await client.request("getMaintenance", args.id);
            if (!current || !current.maintenance) {
                throw new Error(`Maintenance ${args.id} not found.`);
            }
            const payload = buildMaintenancePayload(current.maintenance, args);
            payload.id = args.id;
            const res = await client.request("editMaintenance", payload);
            return {
                ok: true,
                maintenanceID: res.maintenanceID,
                message: `Updated maintenance id ${args.id}.`,
            };
        },
    });

    registerTool(server, config, {
        name: "pause_maintenance",
        title: "Pause maintenance",
        description: "Pause a maintenance window.",
        mutation: true,
        inputSchema: {
            id: z.number().int().describe("Maintenance id"),
        },
        handler: async (args) => {
            await client.request("pauseMaintenance", args.id);
            return { ok: true, message: `Paused maintenance id ${args.id}.` };
        },
    });

    registerTool(server, config, {
        name: "resume_maintenance",
        title: "Resume maintenance",
        description: "Resume a paused maintenance window.",
        mutation: true,
        inputSchema: {
            id: z.number().int().describe("Maintenance id"),
        },
        handler: async (args) => {
            await client.request("resumeMaintenance", args.id);
            return { ok: true, message: `Resumed maintenance id ${args.id}.` };
        },
    });

    registerTool(server, config, {
        name: "delete_maintenance",
        title: "Delete maintenance",
        description: "Permanently delete a maintenance window. Destructive: requires the delete gate and confirm=true.",
        mutation: true,
        destructive: true,
        inputSchema: {
            id: z.number().int().describe("Maintenance id"),
            confirm: z.boolean().describe("Must be true to actually delete. If false, returns a dry-run description."),
        },
        handler: async (args) => {
            if (!args.confirm) {
                return {
                    ok: false,
                    dryRun: true,
                    message: `Would delete maintenance id ${args.id}. Re-run with confirm=true to proceed.`,
                };
            }
            await client.request("deleteMaintenance", args.id);
            return { ok: true, message: `Deleted maintenance id ${args.id}.` };
        },
    });
}

module.exports = { registerMaintenanceTools };
