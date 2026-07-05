const { z } = require("zod");
const { registerTool } = require("./helpers");

/**
 * Parse a cached notification list item's `config` JSON into an object.
 * @param {object} bean A notification list item (has a `config` JSON string).
 * @returns {object} The parsed config (name, type, provider-specific fields).
 */
function parseConfig(bean) {
    try {
        return JSON.parse(bean.config || "{}");
    } catch (e) {
        return {};
    }
}

/**
 * Reduce a cached notification to a non-sensitive summary (never exposes the
 * provider secrets held in `config`).
 * @param {object} bean A notification list item.
 * @returns {object} A trimmed summary.
 */
function summarizeNotification(bean) {
    const config = parseConfig(bean);
    return {
        id: bean.id,
        name: bean.name ?? config.name ?? null,
        type: config.type ?? null,
        isDefault: Boolean(bean.isDefault),
        active: bean.active !== false,
    };
}

/**
 * Register notification MCP tools (read always; create/update/test when
 * mutations are enabled; delete when deletes are enabled).
 * @param {object} server The McpServer instance.
 * @param {object} client The SuperKumaClient instance.
 * @param {object} config Resolved MCP configuration.
 * @returns {void}
 */
function registerNotificationTools(server, client, config) {
    registerTool(server, config, {
        name: "list_notifications",
        title: "List notifications",
        description:
            "List configured notifications as summaries (id, name, type, isDefault). Provider secrets are never returned.",
        handler: async () => {
            const list = client.notifications || [];
            return {
                count: list.length,
                notifications: list.map(summarizeNotification),
            };
        },
    });

    registerTool(server, config, {
        name: "create_notification",
        title: "Create notification",
        description:
            "Create a notification. 'type' selects the provider (e.g. telegram, slack, smtp, webhook, discord, ntfy, gotify, teams). 'config' holds the provider-specific fields (e.g. telegram: telegramBotToken + telegramChatID; slack: slackwebhookURL). The server validates the provider fields.",
        mutation: true,
        inputSchema: {
            name: z.string().min(1).describe("Notification name"),
            type: z
                .string()
                .min(1)
                .describe("Provider type, e.g. telegram, slack, smtp, webhook, discord, ntfy, gotify, teams"),
            config: z
                .record(z.string(), z.any())
                .optional()
                .describe("Provider-specific fields (tokens, URLs, chat ids, ...)"),
            isDefault: z.boolean().optional().describe("Attach to new monitors by default"),
            applyExisting: z.boolean().optional().describe("Also attach to all existing monitors now"),
        },
        handler: async (args) => {
            const notification = {
                ...(args.config || {}),
                name: args.name,
                type: args.type,
                isDefault: args.isDefault ?? false,
                applyExisting: args.applyExisting ?? false,
            };
            const res = await client.request("addNotification", notification, null);
            return {
                ok: true,
                notificationID: res.id,
                message: `Created notification "${args.name}" (id ${res.id}).`,
            };
        },
    });

    registerTool(server, config, {
        name: "update_notification",
        title: "Update notification",
        description:
            "Update an existing notification. Fetches the current config from cache and overlays your changes (run list_notifications first if the cache may be stale).",
        mutation: true,
        inputSchema: {
            id: z.number().int().describe("Notification id"),
            name: z.string().min(1).optional().describe("New name"),
            type: z.string().min(1).optional().describe("New provider type"),
            config: z.record(z.string(), z.any()).optional().describe("Provider-specific fields to overlay"),
            isDefault: z.boolean().optional().describe("Attach to new monitors by default"),
        },
        handler: async (args) => {
            const existing = (client.notifications || []).find((n) => n.id === args.id);
            if (!existing) {
                throw new Error(`Notification ${args.id} not found. Run list_notifications first.`);
            }
            const notification = {
                ...parseConfig(existing),
                ...(args.config || {}),
            };
            if (args.name !== undefined) {
                notification.name = args.name;
            }
            if (args.type !== undefined) {
                notification.type = args.type;
            }
            if (args.isDefault !== undefined) {
                notification.isDefault = args.isDefault;
            }
            notification.applyExisting = false;
            const res = await client.request("addNotification", notification, args.id);
            return {
                ok: true,
                notificationID: res.id,
                message: `Updated notification id ${args.id}.`,
            };
        },
    });

    registerTool(server, config, {
        name: "test_notification",
        title: "Test notification",
        description:
            "Send a test message through a notification config WITHOUT saving it — useful to validate credentials before creating.",
        mutation: true,
        inputSchema: {
            name: z.string().min(1).describe("Notification name (used in the test message)"),
            type: z.string().min(1).describe("Provider type"),
            config: z.record(z.string(), z.any()).optional().describe("Provider-specific fields"),
        },
        handler: async (args) => {
            const notification = {
                ...(args.config || {}),
                name: args.name,
                type: args.type,
            };
            const res = await client.request("testNotification", notification);
            return {
                ok: true,
                message: res && res.msg ? res.msg : "Test sent.",
            };
        },
    });

    registerTool(server, config, {
        name: "delete_notification",
        title: "Delete notification",
        description: "Permanently delete a notification. Destructive: requires the delete gate and confirm=true.",
        mutation: true,
        destructive: true,
        inputSchema: {
            id: z.number().int().describe("Notification id"),
            confirm: z.boolean().describe("Must be true to actually delete. If false, returns a dry-run description."),
        },
        handler: async (args) => {
            if (!args.confirm) {
                const existing = (client.notifications || []).find((n) => n.id === args.id);
                return {
                    ok: false,
                    dryRun: true,
                    message: `Would delete notification id ${args.id}${existing ? ` ("${existing.name}")` : ""}. Re-run with confirm=true to proceed.`,
                };
            }
            await client.request("deleteNotification", args.id);
            return { ok: true, message: `Deleted notification id ${args.id}.` };
        },
    });
}

module.exports = { registerNotificationTools };
