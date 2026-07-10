const { describe, test } = require("node:test");
const assert = require("node:assert");
const {
    severityMeetsThreshold,
    routeMatches,
    resolveNotificationTargets,
} = require("../../server/notification-routing");

describe("notification-routing.js - severityMeetsThreshold()", () => {
    test("a severity meets its own threshold", () => {
        assert.strictEqual(severityMeetsThreshold("critical", "critical"), true);
        assert.strictEqual(severityMeetsThreshold("warning", "warning"), true);
        assert.strictEqual(severityMeetsThreshold("info", "info"), true);
    });

    test("a more severe alert meets a lower threshold", () => {
        assert.strictEqual(severityMeetsThreshold("critical", "warning"), true);
        assert.strictEqual(severityMeetsThreshold("critical", "info"), true);
        assert.strictEqual(severityMeetsThreshold("warning", "info"), true);
    });

    test("a less severe alert does NOT meet a higher threshold", () => {
        assert.strictEqual(severityMeetsThreshold("warning", "critical"), false);
        assert.strictEqual(severityMeetsThreshold("info", "critical"), false);
        assert.strictEqual(severityMeetsThreshold("info", "warning"), false);
    });

    test("throws on an unknown alert severity", () => {
        assert.throws(() => severityMeetsThreshold("catastrophic", "critical"), /Unknown alert severity/);
    });

    test("throws on an unknown route min_severity", () => {
        assert.throws(() => severityMeetsThreshold("critical", "meh"), /Unknown route min_severity/);
    });
});

describe("notification-routing.js - routeMatches()", () => {
    const baseContext = { teamId: 1, monitorId: 10, tagIds: [100, 101], severity: "critical" };

    /**
     * Build a fully-wildcarded route (team/monitor/tag all null), then apply overrides.
     * @param {object} overrides Fields to override on the base wildcard route.
     * @returns {object} A notification_route-shaped object.
     */
    function makeRoute(overrides = {}) {
        return {
            id: 1,
            team_id: null,
            min_severity: "critical",
            monitor_id: null,
            tag_id: null,
            notification_id: 999,
            ...overrides,
        };
    }

    test("a fully wildcarded route (all null selectors) matches any context that meets severity", () => {
        assert.strictEqual(routeMatches(makeRoute(), baseContext), true);
    });

    test("team_id null is a wildcard -- matches regardless of context.teamId", () => {
        assert.strictEqual(routeMatches(makeRoute({ team_id: null }), { ...baseContext, teamId: 42 }), true);
        assert.strictEqual(routeMatches(makeRoute({ team_id: null }), { ...baseContext, teamId: null }), true);
    });

    test("team_id set matches only the same team, not a different or null team", () => {
        assert.strictEqual(routeMatches(makeRoute({ team_id: 1 }), { ...baseContext, teamId: 1 }), true);
        assert.strictEqual(routeMatches(makeRoute({ team_id: 1 }), { ...baseContext, teamId: 2 }), false);
        assert.strictEqual(routeMatches(makeRoute({ team_id: 1 }), { ...baseContext, teamId: null }), false);
    });

    test("severity below the route's min_severity does not match", () => {
        assert.strictEqual(
            routeMatches(makeRoute({ min_severity: "critical" }), { ...baseContext, severity: "warning" }),
            false
        );
    });

    test("severity at or above the route's min_severity matches", () => {
        assert.strictEqual(
            routeMatches(makeRoute({ min_severity: "warning" }), { ...baseContext, severity: "critical" }),
            true
        );
        assert.strictEqual(
            routeMatches(makeRoute({ min_severity: "warning" }), { ...baseContext, severity: "warning" }),
            true
        );
    });

    test("monitor_id null is a wildcard; set requires an exact match", () => {
        assert.strictEqual(routeMatches(makeRoute({ monitor_id: null }), baseContext), true);
        assert.strictEqual(routeMatches(makeRoute({ monitor_id: 10 }), baseContext), true);
        assert.strictEqual(routeMatches(makeRoute({ monitor_id: 11 }), baseContext), false);
    });

    test("tag_id null is a wildcard; set requires the monitor to carry that tag", () => {
        assert.strictEqual(routeMatches(makeRoute({ tag_id: null }), baseContext), true);
        assert.strictEqual(routeMatches(makeRoute({ tag_id: 100 }), baseContext), true);
        assert.strictEqual(routeMatches(makeRoute({ tag_id: 999 }), baseContext), false);
    });

    test("multiple non-null selectors are a conjunction -- ALL must hold, not just one", () => {
        // team matches, but monitor doesn't -> overall no match.
        assert.strictEqual(
            routeMatches(makeRoute({ team_id: 1, monitor_id: 11 }), baseContext),
            false,
            "team matching alone should not be enough when monitor_id also fails"
        );
        // team matches AND monitor matches -> match.
        assert.strictEqual(routeMatches(makeRoute({ team_id: 1, monitor_id: 10 }), baseContext), true);
        // team matches AND monitor matches AND tag matches -> match.
        assert.strictEqual(
            routeMatches(makeRoute({ team_id: 1, monitor_id: 10, tag_id: 101 }), baseContext),
            true
        );
        // team matches AND monitor matches, but tag doesn't -> no match.
        assert.strictEqual(
            routeMatches(makeRoute({ team_id: 1, monitor_id: 10, tag_id: 777 }), baseContext),
            false
        );
    });
});

describe("notification-routing.js - resolveNotificationTargets()", () => {
    const context = { teamId: 1, monitorId: 10, tagIds: [100], severity: "critical" };

    test("no routes at all -> returns EXACTLY the static list (legacy byte-identical contract)", () => {
        const staticNotifications = [{ id: 1, name: "static-a" }, { id: 2, name: "static-b" }];

        const result = resolveNotificationTargets({
            staticNotifications,
            routes: [],
            allNotifications: staticNotifications,
            context,
        });

        assert.deepStrictEqual(result, staticNotifications);
    });

    test("routes exist but none match this context -> still returns exactly the static list", () => {
        const staticNotifications = [{ id: 1, name: "static-a" }];
        const nonMatchingRoute = { id: 5, team_id: 2, min_severity: "critical", monitor_id: null, tag_id: null, notification_id: 999 };

        const result = resolveNotificationTargets({
            staticNotifications,
            routes: [nonMatchingRoute],
            allNotifications: [...staticNotifications, { id: 999, name: "routed-only" }],
            context,
        });

        assert.deepStrictEqual(result, staticNotifications);
    });

    test("a matching route whose notification is NOT already static -> unioned into the result", () => {
        const staticNotifications = [{ id: 1, name: "static-a" }];
        const routedNotification = { id: 999, name: "routed-only" };
        const matchingRoute = {
            id: 5,
            team_id: null,
            min_severity: "critical",
            monitor_id: null,
            tag_id: null,
            notification_id: 999,
        };

        const result = resolveNotificationTargets({
            staticNotifications,
            routes: [matchingRoute],
            allNotifications: [...staticNotifications, routedNotification],
            context,
        });

        assert.strictEqual(result.length, 2);
        assert.deepStrictEqual(
            result.map((n) => n.id).sort(),
            [1, 999]
        );
    });

    test("a matching route whose notification IS already static -> deduplicated, no duplicate entry", () => {
        const staticNotifications = [{ id: 1, name: "static-a" }];
        const matchingRouteToSameNotification = {
            id: 5,
            team_id: null,
            min_severity: "critical",
            monitor_id: null,
            tag_id: null,
            notification_id: 1,
        };

        const result = resolveNotificationTargets({
            staticNotifications,
            routes: [matchingRouteToSameNotification],
            allNotifications: staticNotifications,
            context,
        });

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 1);
    });

    test("multiple matching routes pointing at the same notification -> deduplicated to one entry", () => {
        const staticNotifications = [];
        const routedNotification = { id: 999, name: "routed-only" };
        const routeA = { id: 5, team_id: null, min_severity: "critical", monitor_id: null, tag_id: null, notification_id: 999 };
        const routeB = { id: 6, team_id: null, min_severity: "warning", monitor_id: 10, tag_id: null, notification_id: 999 };

        const result = resolveNotificationTargets({
            staticNotifications,
            routes: [routeA, routeB],
            allNotifications: [routedNotification],
            context,
        });

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 999);
    });

    test("throws if a matching route points at a notification_id with no corresponding notification row", () => {
        const dangling = { id: 5, team_id: null, min_severity: "critical", monitor_id: null, tag_id: null, notification_id: 12345 };

        assert.throws(
            () =>
                resolveNotificationTargets({
                    staticNotifications: [],
                    routes: [dangling],
                    allNotifications: [],
                    context,
                }),
            /unknown notification_id 12345/
        );
    });
});
