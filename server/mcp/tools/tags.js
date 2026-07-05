const { z } = require("zod");
const { registerTool } = require("./helpers");

/**
 * Register tag-related MCP tools (read always; create/update + monitor-tag
 * linking when mutations are enabled; tag delete when deletes are enabled).
 * @param {object} server The McpServer instance.
 * @param {object} client The SuperKumaClient instance.
 * @param {object} config Resolved MCP configuration.
 * @returns {void}
 */
function registerTagTools(server, client, config) {
    registerTool(server, config, {
        name: "list_tags",
        title: "List tags",
        description: "List all tags defined in SuperKuma (id, name, color).",
        handler: async () => {
            const res = await client.request("getTags");
            return {
                count: (res.tags || []).length,
                tags: res.tags || [],
            };
        },
    });

    registerTool(server, config, {
        name: "create_tag",
        title: "Create tag",
        description: "Create a new tag with a name and color.",
        mutation: true,
        inputSchema: {
            name: z.string().min(1).describe("Tag name"),
            color: z.string().optional().describe("Tag color as a hex string, e.g. #4caf50. Default #59636b"),
        },
        handler: async (args) => {
            const res = await client.request("addTag", {
                name: args.name,
                color: args.color || "#59636b",
            });
            return {
                ok: true,
                tag: res.tag,
                message: `Created tag "${args.name}".`,
            };
        },
    });

    registerTool(server, config, {
        name: "update_tag",
        title: "Update tag",
        description: "Rename a tag or change its color.",
        mutation: true,
        inputSchema: {
            id: z.number().int().describe("Tag id"),
            name: z.string().min(1).describe("Tag name"),
            color: z.string().describe("Tag color as a hex string, e.g. #4caf50"),
        },
        handler: async (args) => {
            const res = await client.request("editTag", {
                id: args.id,
                name: args.name,
                color: args.color,
            });
            return {
                ok: true,
                tag: res.tag,
                message: `Updated tag id ${args.id}.`,
            };
        },
    });

    registerTool(server, config, {
        name: "delete_tag",
        title: "Delete tag",
        description:
            "Permanently delete a tag (and its links to monitors). Destructive: requires the delete gate and confirm=true.",
        mutation: true,
        destructive: true,
        inputSchema: {
            id: z.number().int().describe("Tag id"),
            confirm: z.boolean().describe("Must be true to actually delete. If false, returns a dry-run description."),
        },
        handler: async (args) => {
            if (!args.confirm) {
                return {
                    ok: false,
                    dryRun: true,
                    message: `Would delete tag id ${args.id}. Re-run with confirm=true to proceed.`,
                };
            }
            await client.request("deleteTag", args.id);
            return { ok: true, message: `Deleted tag id ${args.id}.` };
        },
    });

    registerTool(server, config, {
        name: "add_monitor_tag",
        title: "Attach tag to monitor",
        description: "Attach an existing tag to a monitor, optionally with a value (e.g. a label like 'prod').",
        mutation: true,
        inputSchema: {
            tagId: z.number().int().describe("Tag id"),
            monitorId: z.number().int().describe("Monitor id"),
            value: z.string().optional().describe("Optional value/label for this tag on this monitor"),
        },
        handler: async (args) => {
            await client.request("addMonitorTag", args.tagId, args.monitorId, args.value || "");
            return { ok: true, message: `Attached tag ${args.tagId} to monitor ${args.monitorId}.` };
        },
    });

    registerTool(server, config, {
        name: "remove_monitor_tag",
        title: "Detach tag from monitor",
        description: "Remove a tag (with the given value) from a monitor. Reversible via add_monitor_tag.",
        mutation: true,
        inputSchema: {
            tagId: z.number().int().describe("Tag id"),
            monitorId: z.number().int().describe("Monitor id"),
            value: z.string().optional().describe("The value/label of the tag link to remove (default empty)"),
        },
        handler: async (args) => {
            await client.request("deleteMonitorTag", args.tagId, args.monitorId, args.value || "");
            return { ok: true, message: `Detached tag ${args.tagId} from monitor ${args.monitorId}.` };
        },
    });
}

module.exports = { registerTagTools };
