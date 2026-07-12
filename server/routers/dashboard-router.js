const express = require("express");
const apicache = require("../modules/apicache");
const { SuperKumaServer } = require("../superkuma-server");
const { R } = require("redbean-node");
const { allowDevAllOrigin, sendHttpError } = require("../util-server");
const { UptimeCalculator } = require("../uptime-calculator");
const { getWidgets } = require("../socket-handlers/dashboard-socket-handler");
const { z } = require("zod");
const { validate } = require("../validation");

const router = express.Router();
const cache = apicache.middleware;
const server = SuperKumaServer.getInstance();

// Dashboard slugs are always lower-cased before lookup, so only lowercase
// letters, digits and hyphens are ever valid (same shape as status page slugs).
const slugSchema = z.string().regex(/^[a-z0-9-]+$/);

/**
 * Is the given slug a well-formed dashboard slug?
 * @param {string} slug Slug to check (already lower-cased).
 * @returns {boolean} True if the slug matches the expected format.
 */
function isValidSlug(slug) {
    try {
        validate(slugSchema, slug);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Public, read-only dashboard page (ADR-0017 D3). Serves the SPA shell; the Vue
 * app fetches its data from /api/panel/:slug, which is where the `published`
 * gate is actually enforced.
 *
 * Uses `/panel/:slug` (not `/dashboard/:slug`) because `/dashboard/:id` is
 * already the authenticated monitor-detail route -- `/panel` avoids shadowing it.
 */
router.get("/panel/:slug", cache("5 minutes"), async (request, response) => {
    const slug = String(request.params.slug).toLowerCase();
    if (!isValidSlug(slug)) {
        response.status(404).send(server.indexHTML);
        return;
    }
    response.send(server.indexHTML);
});

/**
 * Public dashboard DATA endpoint. Returns ONLY published dashboards, and only
 * non-sensitive fields: the panel layout plus each monitor's public heartbeat
 * view (status + extracted metric value, never raw config/credentials). A
 * missing OR unpublished slug returns 404 -- never 403 -- so existence is not
 * leaked.
 */
router.get("/api/panel/:slug", cache("1 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        const slug = String(request.params.slug).toLowerCase();
        if (!isValidSlug(slug)) {
            sendHttpError(response, "Dashboard Not Found");
            return;
        }

        const dashboard = await R.findOne("dashboard", "slug = ?", [slug]);
        // A non-existent OR unpublished dashboard is indistinguishable to a
        // public caller: both are a plain 404, so publishing state does not leak.
        if (!dashboard || !dashboard.published) {
            sendHttpError(response, "Dashboard Not Found");
            return;
        }

        const panels = await getWidgets(dashboard.id);

        // Batch monitor types once (drives Heartbeat.toPublicJSON's metric
        // extraction), then fetch each panel-referenced monitor's recent public
        // heartbeats + 24h uptime -- same non-sensitive shape the status page
        // exposes.
        const monitorIdList = [...new Set(panels.map((p) => p.monitorId).filter((id) => id != null))];
        const monitorTypeById = {};
        if (monitorIdList.length > 0) {
            const placeholders = monitorIdList.map(() => "?").join(",");
            const typeRows = await R.getAll(
                `SELECT id, type FROM monitor WHERE id IN (${placeholders})`,
                monitorIdList
            );
            for (const row of typeRows) {
                monitorTypeById[row.id] = row.type;
            }
        }

        const heartbeatList = {};
        const uptimeList = {};
        for (const monitorId of monitorIdList) {
            let list = await R.getAll(`SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 100`, [
                monitorId,
            ]);
            list = R.convertToBeans("heartbeat", list);
            heartbeatList[monitorId] = list.reverse().map((row) => row.toPublicJSON(monitorTypeById[monitorId]));

            const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorId);
            uptimeList[`${monitorId}_24`] = uptimeCalculator.get24Hour().uptime;
        }

        response.json({
            dashboard: {
                title: dashboard.title,
                slug: dashboard.slug,
                description: dashboard.description ?? null,
                refreshInterval: dashboard.refresh_interval ?? 300,
                theme: dashboard.theme ?? "auto",
            },
            panels,
            heartbeatList,
            uptimeList,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

module.exports = router;
