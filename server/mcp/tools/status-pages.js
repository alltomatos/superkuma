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
        name: "save_status_page",
        title: "Save status page layout",
        description:
            "Configure a status page's title/description/appearance and its groups of monitors. 'groups' fully REPLACES the current layout (like editing groups in the dashboard and hitting Save) -- always pass every group you want to keep, in the order you want them shown. Existing groups not included are removed (their monitors are just unlisted from the page, not deleted). Every field besides slug/groups is optional and left unchanged when omitted. Requires the page to already exist (create_status_page first).",
        mutation: true,
        inputSchema: {
            slug: z.string().min(1).describe("Status page slug"),
            title: z.string().min(1).optional().describe("Status page title"),
            description: z.string().optional().describe("Status page description"),
            customCSS: z
                .string()
                .optional()
                .describe("Custom CSS injected into the public status page (same box as the dashboard's editor)"),
            theme: z.enum(["auto", "light", "dark"]).optional().describe("Color theme"),
            footerText: z.string().nullable().optional().describe("Custom footer text, null to clear"),
            showPoweredBy: z.boolean().optional().describe("Show the \"Powered by SuperKuma\" footer badge"),
            showTags: z.boolean().optional().describe("Show each monitor's tags on the page"),
            showCertificateExpiry: z.boolean().optional().describe("Show TLS certificate expiry per monitor"),
            showOnlyLastHeartbeat: z
                .boolean()
                .optional()
                .describe("Show only the most recent heartbeat instead of the full history bar"),
            autoRefreshInterval: z.number().int().positive().optional().describe("Auto-refresh interval in seconds"),
            tabRotationEnabled: z
                .boolean()
                .optional()
                .describe(
                    "Wallboard/TV mode: show one group at a time, auto-advancing to the next -- instead of all groups at once"
                ),
            tabRotationInterval: z
                .number()
                .int()
                .min(3)
                .optional()
                .describe("Seconds each group stays on screen before rotating to the next (only used when tabRotationEnabled)"),
            soundAlertsEnabled: z
                .boolean()
                .optional()
                .describe("Play a sound and show a toast in the browser when a monitor on this page goes down"),
            groups: z
                .array(
                    z.object({
                        name: z.string().min(1).describe("Section heading, e.g. 'Domain Controllers'"),
                        monitorIds: z
                            .array(z.number().int())
                            .describe("Monitor ids to list in this section, in display order"),
                    })
                )
                .describe("The complete list of sections and their monitors, top to bottom"),
        },
        handler: async (args) => {
            const current = await client.request("getStatusPage", args.slug);
            if (!current || !current.config) {
                throw new Error(`Status page "${args.slug}" not found. Create it first with create_status_page.`);
            }
            const cfg = current.config;

            const OPTIONAL_FIELDS = [
                "title",
                "description",
                "customCSS",
                "theme",
                "footerText",
                "showPoweredBy",
                "showTags",
                "showCertificateExpiry",
                "showOnlyLastHeartbeat",
                "autoRefreshInterval",
                "tabRotationEnabled",
                "tabRotationInterval",
                "soundAlertsEnabled",
            ];
            const mergedConfig = { ...cfg };
            for (const field of OPTIONAL_FIELDS) {
                if (args[field] !== undefined) {
                    mergedConfig[field] = args[field];
                }
            }

            const publicGroupList = args.groups.map((g) => ({
                name: g.name,
                monitorList: g.monitorIds.map((id) => ({ id })),
            }));

            // Preserve the existing logo: saveStatusPage treats a non-"data:" imgDataUrl as a
            // pass-through URL, so re-submitting the current icon leaves it unchanged.
            const imgDataUrl = cfg.icon || "";

            await client.request("saveStatusPage", args.slug, mergedConfig, imgDataUrl, publicGroupList);

            return {
                ok: true,
                message: `Saved status page "${args.slug}" with ${publicGroupList.length} group(s).`,
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
