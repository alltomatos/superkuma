let express = require("express");
const apicache = require("../modules/apicache");
const { SuperKumaServer } = require("../uptime-kuma-server");
const StatusPage = require("../model/status_page");
const { allowDevAllOrigin, sendHttpError } = require("../util-server");
const { R } = require("redbean-node");
const { badgeConstants } = require("../../src/util");
const { makeBadge } = require("badge-maker");
const { UptimeCalculator } = require("../uptime-calculator");
const { z } = require("zod");
const { validate } = require("../validation");

let router = express.Router();

let cache = apicache.middleware;
const server = SuperKumaServer.getInstance();

// Status page slugs are always lower-cased before being looked up, so only
// lowercase letters, digits and hyphens are ever valid.
const slugSchema = z.string().regex(/^[a-z0-9-]+$/);

/**
 * Is the given slug a well-formed status page slug?
 * @param {string} slug Slug to check (already lower-cased)
 * @returns {boolean} True if the slug matches the expected format
 */
function isValidSlug(slug) {
    // "index.html" is a special case: express substitutes it for an empty
    // ":slug" param (e.g. requesting "/status/" with a trailing slash), and
    // StatusPage.handleStatusPageResponse() maps it to the "default" page.
    if (slug === "index.html") {
        return true;
    }

    try {
        validate(slugSchema, slug);
        return true;
    } catch (e) {
        return false;
    }
}

router.get("/status/:slug", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    if (!isValidSlug(slug)) {
        response.status(404).send(server.indexHTML);
        return;
    }

    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status/:slug/rss", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    if (!isValidSlug(slug)) {
        response.status(404).send(server.indexHTML);
        return;
    }

    await StatusPage.handleStatusPageRSSResponse(response, slug, request);
});

router.get("/status", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status-page", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

// Status page config, incident, monitor list
router.get("/api/status-page/:slug", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        if (!isValidSlug(slug)) {
            sendHttpError(response, "Status Page Not Found");
            return null;
        }

        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Status Page Not Found");
            return null;
        }

        let statusPageData = await StatusPage.getStatusPageData(statusPage);

        // Response
        response.json(statusPageData);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status Page Polling Data
// Can fetch only if published
router.get("/api/status-page/heartbeat/:slug", cache("1 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let heartbeatList = {};
        let uptimeList = {};

        let slug = request.params.slug;
        slug = slug.toLowerCase();

        if (!isValidSlug(slug)) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }

        let statusPageID = await StatusPage.slugToID(slug);

        let monitorIDList = await R.getCol(
            `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `,
            [statusPageID]
        );

        for (let monitorID of monitorIDList) {
            let list = await R.getAll(
                `
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 100
            `,
                [monitorID]
            );

            list = R.convertToBeans("heartbeat", list);
            heartbeatList[monitorID] = list.reverse().map((row) => row.toPublicJSON());

            const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);
            uptimeList[`${monitorID}_24`] = uptimeCalculator.get24Hour().uptime;
        }

        response.json({
            heartbeatList,
            uptimeList,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status page's manifest.json
router.get("/api/status-page/:slug/manifest.json", cache("1440 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        if (!isValidSlug(slug)) {
            sendHttpError(response, "Not Found");
            return;
        }

        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Not Found");
            return;
        }

        // Response
        response.json({
            name: statusPage.title,
            start_url: "/status/" + statusPage.slug,
            display: "standalone",
            icons: [
                {
                    src: statusPage.icon,
                    sizes: "128x128",
                    type: "image/png",
                },
            ],
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/status-page/:slug/incident-history", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let slug = request.params.slug;
        slug = slug.toLowerCase();

        if (!isValidSlug(slug)) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }

        let statusPageID = await StatusPage.slugToID(slug);

        if (!statusPageID) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }

        const cursor = request.query.cursor || null;
        const result = await StatusPage.getIncidentHistory(statusPageID, cursor, true);
        response.json({
            ok: true,
            ...result,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// overall status-page status badge
router.get("/api/status-page/:slug/badge", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    const {
        label,
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        partialColor = "#F6BE00",
        maintenanceColor = "#808080",
        style = badgeConstants.defaultStyle,
    } = request.query;

    try {
        if (!isValidSlug(slug)) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }

        const statusPageID = await StatusPage.slugToID(slug);

        let monitorIDList = await R.getCol(
            `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `,
            [statusPageID]
        );

        let hasUp = false;
        let hasDown = false;
        let hasMaintenance = false;

        for (let monitorID of monitorIDList) {
            // retrieve the latest heartbeat
            let beat = await R.getAll(
                `
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 1
            `,
                [monitorID]
            );

            // to be sure, when corresponding monitor not found
            if (beat.length === 0) {
                continue;
            }
            // handle status of beat
            if (beat[0].status === 3) {
                hasMaintenance = true;
            } else if (beat[0].status === 2) {
                // ignored
            } else if (beat[0].status === 1) {
                hasUp = true;
            } else {
                hasDown = true;
            }
        }

        const badgeValues = { style };

        if (!hasUp && !hasDown && !hasMaintenance) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            if (hasMaintenance) {
                badgeValues.label = label ? label : "";
                badgeValues.color = maintenanceColor;
                badgeValues.message = "Maintenance";
            } else if (hasUp && !hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = upColor;
                badgeValues.message = "Up";
            } else if (hasUp && hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = partialColor;
                badgeValues.message = "Degraded";
            } else {
                badgeValues.label = label ? label : "";
                badgeValues.color = downColor;
                badgeValues.message = "Down";
            }
        }

        // build the svg based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

module.exports = router;
