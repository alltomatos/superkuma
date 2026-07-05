const { z } = require("zod");
const { registerTool } = require("./helpers");

/**
 * Reduce a status page object to a compact summary for list views.
 * @param {object} page A status page object.
 * @returns {object} A trimmed summary.
 */
function summarizeStatusPage(page) {
    return {
        id: page.id,
        slug: page.slug,
        title: page.title,
        published: page.published !== false,
        theme: page.theme ?? null,
    };
}

const INCIDENT_STYLES = ["info", "warning", "danger", "primary", "light", "dark"];

/**
 * Register status-page MCP tools (read always; create/incident tools when
 * mutations are enabled; delete when deletes are enabled).
 * @param {object} server The McpServer instance.
 * @param {object} client The SuperKumaClient instance.
 * @param {object} config Resolved MCP configuration.
 * @returns {void}
 */
function registerStatusPageTools(server, client, config) {
    registerTool(server, config, {
        name: "list_status_pages",
        title: "List status pages",
        description: "List all status pages as summaries (id, slug, title, published).",
        handler: async () => {
            const pages = await client.listStatusPages();
            return {
                count: pages.length,
                statusPages: pages.map(summarizeStatusPage),
            };
        },
    });

    registerTool(server, config, {
        name: "get_status_page",
        title: "Get status page",
        description: "Fetch a status page's full configuration by slug.",
        inputSchema: {
            slug: z.string().min(1).describe("Status page slug"),
        },
        handler: async (args) => {
            const res = await client.request("getStatusPage", args.slug);
            return res.config;
        },
    });

    registerTool(server, config, {
        name: "create_status_page",
        title: "Create status page",
        description:
            "Create a new status page with a title and slug (slug: a-z, 0-9 and dashes only). Use save/get tools or the dashboard to configure its monitors afterwards.",
        mutation: true,
        inputSchema: {
            title: z.string().min(1).describe("Status page title"),
            slug: z.string().min(1).describe("URL slug (lowercase letters, digits and dashes)"),
        },
        handler: async (args) => {
            const res = await client.request("addStatusPage", args.title, args.slug);
            return {
                ok: true,
                slug: res.slug,
                message: `Created status page "${args.title}" (slug ${res.slug}).`,
            };
        },
    });

    registerTool(server, config, {
        name: "post_incident",
        title: "Post status-page incident",
        description: "Post (or pin) an incident on a status page.",
        mutation: true,
        inputSchema: {
            slug: z.string().min(1).describe("Status page slug"),
            title: z.string().min(1).describe("Incident title"),
            content: z.string().min(1).describe("Incident content/description"),
            style: z.enum(INCIDENT_STYLES).default("warning").describe("Visual style"),
        },
        handler: async (args) => {
            const res = await client.request("postIncident", args.slug, {
                title: args.title,
                content: args.content,
                style: args.style,
            });
            return {
                ok: true,
                incident: res.incident,
                message: `Posted incident on "${args.slug}".`,
            };
        },
    });

    registerTool(server, config, {
        name: "resolve_incident",
        title: "Resolve status-page incident",
        description: "Unpin/resolve the currently pinned incident on a status page.",
        mutation: true,
        inputSchema: {
            slug: z.string().min(1).describe("Status page slug"),
        },
        handler: async (args) => {
            await client.request("unpinIncident", args.slug);
            return { ok: true, message: `Resolved the pinned incident on "${args.slug}".` };
        },
    });

    registerTool(server, config, {
        name: "delete_status_page",
        title: "Delete status page",
        description:
            "Permanently delete a status page (and its incidents/groups). Destructive: requires the delete gate and confirm=true.",
        mutation: true,
        destructive: true,
        inputSchema: {
            slug: z.string().min(1).describe("Status page slug"),
            confirm: z.boolean().describe("Must be true to actually delete. If false, returns a dry-run description."),
        },
        handler: async (args) => {
            if (!args.confirm) {
                return {
                    ok: false,
                    dryRun: true,
                    message: `Would delete status page "${args.slug}". Re-run with confirm=true to proceed.`,
                };
            }
            await client.request("deleteStatusPage", args.slug);
            return { ok: true, message: `Deleted status page "${args.slug}".` };
        },
    });
}

module.exports = { registerStatusPageTools };
