process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");

const { statusPageSocketHandler } = require("../../server/socket-handlers/status-page-socket-handler");
const { setEnforcementEnabled, buildActor, ForbiddenError } = require("../../server/security/authz");
const { Settings } = require("../../server/settings");

const testDb = new TestDB("./data/test-status-page-authz");

/**
 * Build a mock socket.io-like object that captures registered "on" handlers
 * so socket handler logic can be invoked directly, without a real socket.io
 * connection. Mirrors the helper used in test-apikey-remoteinstance-authz.js.
 * @param {number} userID Fake logged-in user id to attach to the mock socket
 * @param {object|null} actor Actor object to attach as socket.actor
 * @returns {{userID: number, actor: object|null, on: Function, trigger: Function}} Mock socket
 */
function createMockSocket(userID, actor) {
    const handlers = {};
    return {
        userID,
        actor: actor === undefined ? null : actor,
        on(event, handler) {
            handlers[event] = handler;
        },
        /**
         * Invoke a previously-registered handler by event name.
         * @param {string} event Event name
         * @param {...any} args Arguments to forward to the handler
         * @returns {Promise<any>} Whatever the handler's callback receives
         */
        trigger(event, ...args) {
            return new Promise((resolve, reject) => {
                if (!handlers[event]) {
                    reject(new Error(`No handler registered for event: ${event}`));
                    return;
                }
                handlers[event](...args, (result) => resolve(result));
            });
        },
    };
}

/**
 * Look up a built-in role's id (team_id NULL global template) by slug.
 * @param {string} slug Role slug, e.g. "owner" or "viewer".
 * @returns {Promise<number>} The role id.
 */
async function getBuiltinRoleId(slug) {
    const role = await R.getRow("SELECT id FROM `role` WHERE team_id IS NULL AND slug = ?", [slug]);
    if (!role) {
        throw new Error(`Built-in role not seeded: ${slug}`);
    }
    return role.id;
}

/**
 * Create a team row and return its id.
 * @param {string} slug Unique team slug.
 * @param {string} name Human-readable team name.
 * @returns {Promise<number>} The new team's id.
 */
async function createTeam(slug, name) {
    const bean = R.dispense("team");
    bean.name = name;
    bean.slug = slug;
    bean.is_system = false;
    bean.active = true;
    return R.store(bean);
}

/**
 * Add a user to a team with a given built-in role slug.
 * @param {number} teamId Team id.
 * @param {number} userId User id.
 * @param {string} roleSlug Built-in role slug to assign.
 * @returns {Promise<void>}
 */
async function addTeamMember(teamId, userId, roleSlug) {
    const roleId = await getBuiltinRoleId(roleSlug);
    const bean = R.dispense("team_user");
    bean.team_id = teamId;
    bean.user_id = userId;
    bean.role_id = roleId;
    await R.store(bean);
}

/**
 * Build an Actor for a user who is an "owner" of exactly one team.
 * @param {number} userId The user id.
 * @param {number} teamId The team id the actor owns.
 * @returns {object} The constructed Actor.
 */
function ownerActorFor(userId, teamId) {
    return buildActor({ userId, isSuperadmin: false }, [{ teamId, roleSlug: "owner" }], teamId);
}

/**
 * Create a status_page row owned by the given team and return its id + slug.
 * @param {number} teamId Owning team id.
 * @param {string} slug Unique slug for the page.
 * @returns {Promise<{id: number, slug: string}>} The created page's id and slug.
 */
async function createStatusPage(teamId, slug) {
    const bean = R.dispense("status_page");
    bean.slug = slug;
    bean.title = `Title for ${slug}`;
    bean.theme = "auto";
    bean.icon = "";
    bean.autoRefreshInterval = 300;
    bean.team_id = teamId;
    const id = await R.store(bean);
    return { id, slug };
}

/**
 * Create an incident row belonging to a status page.
 * @param {number} statusPageId Owning status page id.
 * @param {string} title Incident title.
 * @returns {Promise<number>} The created incident's id.
 */
async function createIncident(statusPageId, title) {
    const bean = R.dispense("incident");
    bean.title = title;
    bean.content = "content";
    bean.style = "warning";
    bean.pin = true;
    bean.active = true;
    bean.status_page_id = statusPageId;
    bean.created_date = R.isoDateTime();
    return R.store(bean);
}

describe("status-page authz retrofit (ADR-0010 P3)", () => {
    let teamA;
    let teamB;
    let userA;
    let userB;

    before(async () => {
        await testDb.create();

        teamA = await createTeam("team-a-status-page", "Team A");
        teamB = await createTeam("team-b-status-page", "Team B");

        // Two distinct real users so any legacy per-row checks have something
        // meaningful to key off of.
        const beanA = R.dispense("user");
        beanA.username = "authz-status-user-a";
        beanA.password = "not-used";
        userA = await R.store(beanA);

        const beanB = R.dispense("user");
        beanB.username = "authz-status-user-b";
        beanB.password = "not-used";
        userB = await R.store(beanB);

        await addTeamMember(teamA, userA, "owner");
        await addTeamMember(teamB, userB, "owner");
    });

    after(async () => {
        setEnforcementEnabled(false);
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    // -------------------------------------------------------------------
    // Enforcement OFF (default / dark-launch): behaviour unchanged.
    // -------------------------------------------------------------------
    describe("enforcement OFF (dark-launch default)", () => {
        test("getStatusPage still returns a team-B page's config to a team-A actor", async () => {
            const page = await createStatusPage(teamB, "off-get-status-page");

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("getStatusPage", page.slug);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.config.slug, page.slug);
        });

        test("deleteStatusPage still deletes a team-B page for a team-A actor (legacy behaviour unchanged)", async () => {
            const page = await createStatusPage(teamB, "off-delete-status-page");

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("deleteStatusPage", page.slug);
            assert.strictEqual(result.ok, true);

            const after1 = await R.findOne("status_page", " id = ? ", [page.id]);
            assert.strictEqual(after1, null, "status_page row should be deleted");
        });

        test("postIncident still no-ops safely (no throw) when actor is null (defensive afterLogin failure path)", async () => {
            const page = await createStatusPage(teamA, "off-null-actor-post-incident");

            const socket = createMockSocket(userA, null);
            statusPageSocketHandler(socket);

            const result = await socket.trigger("postIncident", page.slug, {
                title: "Incident title",
                content: "Incident content",
                style: "warning",
            });
            assert.strictEqual(
                result.ok,
                true,
                "requireResource must be a true no-op while OFF, even with a null actor"
            );
        });

        test("deleteIncident still deletes a team-B page's incident for a team-A actor", async () => {
            const page = await createStatusPage(teamB, "off-delete-incident-page");
            const incidentId = await createIncident(page.id, "Old incident");

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("deleteIncident", page.slug, incidentId);
            assert.strictEqual(result.ok, true);

            const gone = await R.findOne("incident", " id = ? ", [incidentId]);
            assert.strictEqual(gone, null);
        });
    });

    // -------------------------------------------------------------------
    // Enforcement ON (test-only): real two-team denial, exercised through
    // the actual handler code paths (not just direct calls into authz).
    // -------------------------------------------------------------------
    describe("enforcement ON (two-team isolation, exercised through the real handlers)", () => {
        before(() => setEnforcementEnabled(true));
        after(() => setEnforcementEnabled(false));

        test("getStatusPage denies a team-A actor reading a team-B page", async () => {
            const page = await createStatusPage(teamB, "on-deny-get-status-page");

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("getStatusPage", page.slug);
            assert.strictEqual(result.ok, false, "cross-team read must be denied");
            assert.ok(result.msg.includes("Permission denied"), `expected ForbiddenError message, got: ${result.msg}`);
        });

        test("getStatusPage allows a team-B actor to read its own page", async () => {
            const page = await createStatusPage(teamB, "on-allow-get-status-page");

            const socket = createMockSocket(userB, ownerActorFor(userB, teamB));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("getStatusPage", page.slug);
            assert.strictEqual(result.ok, true, "same-team read must be allowed");
            assert.strictEqual(result.config.slug, page.slug);
        });

        test("deleteStatusPage denies a team-A actor deleting a team-B page", async () => {
            const page = await createStatusPage(teamB, "on-deny-delete-status-page");

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("deleteStatusPage", page.slug);
            assert.strictEqual(result.ok, false, "cross-team delete must be denied");
            assert.ok(result.msg.includes("Permission denied"), `expected ForbiddenError message, got: ${result.msg}`);

            const stillThere = await R.findOne("status_page", " id = ? ", [page.id]);
            assert.ok(stillThere, "status_page row must survive a denied cross-team delete");
        });

        test("deleteStatusPage allows a team-B actor to delete its own page", async () => {
            const page = await createStatusPage(teamB, "on-allow-delete-status-page");

            const socket = createMockSocket(userB, ownerActorFor(userB, teamB));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("deleteStatusPage", page.slug);
            assert.strictEqual(result.ok, true, "same-team delete must be allowed");

            const gone = await R.findOne("status_page", " id = ? ", [page.id]);
            assert.strictEqual(gone, null);
        });

        test("postIncident denies a team-A actor posting an incident on a team-B page", async () => {
            const page = await createStatusPage(teamB, "on-deny-post-incident");

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("postIncident", page.slug, {
                title: "Cross-team incident",
                content: "content",
                style: "warning",
            });
            assert.strictEqual(result.ok, false, "cross-team incident post must be denied");
            assert.ok(result.msg.includes("Permission denied"), `expected ForbiddenError message, got: ${result.msg}`);

            const incidents = await R.find("incident", " status_page_id = ? ", [page.id]);
            assert.strictEqual(incidents.length, 0, "no incident should have been created");
        });

        test("postIncident allows a team-B actor to post an incident on its own page", async () => {
            const page = await createStatusPage(teamB, "on-allow-post-incident");

            const socket = createMockSocket(userB, ownerActorFor(userB, teamB));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("postIncident", page.slug, {
                title: "Same-team incident",
                content: "content",
                style: "warning",
            });
            assert.strictEqual(result.ok, true, "same-team incident post must be allowed");
        });

        test("deleteIncident denies a team-A actor deleting a team-B page's incident", async () => {
            const page = await createStatusPage(teamB, "on-deny-delete-incident");
            const incidentId = await createIncident(page.id, "To keep");

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("deleteIncident", page.slug, incidentId);
            assert.strictEqual(result.ok, false, "cross-team incident delete must be denied");
            assert.ok(result.msg.includes("Permission denied"), `expected ForbiddenError message, got: ${result.msg}`);

            const stillThere = await R.findOne("incident", " id = ? ", [incidentId]);
            assert.ok(stillThere, "incident row must survive a denied cross-team delete");
        });

        test("deleteIncident allows a team-B actor to delete its own page's incident", async () => {
            const page = await createStatusPage(teamB, "on-allow-delete-incident");
            const incidentId = await createIncident(page.id, "To delete");

            const socket = createMockSocket(userB, ownerActorFor(userB, teamB));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("deleteIncident", page.slug, incidentId);
            assert.strictEqual(result.ok, true, "same-team incident delete must be allowed");

            const gone = await R.findOne("incident", " id = ? ", [incidentId]);
            assert.strictEqual(gone, null);
        });

        test("getIncidentHistory denies a team-A actor reading a team-B page's incident history", async () => {
            const page = await createStatusPage(teamB, "on-deny-incident-history");
            await createIncident(page.id, "History incident");

            const socket = createMockSocket(userA, ownerActorFor(userA, teamA));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("getIncidentHistory", page.slug, null);
            assert.strictEqual(result.ok, false, "cross-team incident history read must be denied");
            assert.ok(result.msg.includes("Permission denied"), `expected ForbiddenError message, got: ${result.msg}`);
        });

        test("getIncidentHistory allows a team-B actor to read its own page's incident history", async () => {
            const page = await createStatusPage(teamB, "on-allow-incident-history");
            await createIncident(page.id, "History incident");

            const socket = createMockSocket(userB, ownerActorFor(userB, teamB));
            statusPageSocketHandler(socket);

            const result = await socket.trigger("getIncidentHistory", page.slug, null);
            assert.strictEqual(result.ok, true, "same-team incident history read must be allowed");
        });
    });

    // -------------------------------------------------------------------
    // Direct sanity check that the retrofit uses the exact contract
    // (ForbiddenError, real teamIdLoader-resolved team) rather than a
    // hand-rolled equivalent.
    // -------------------------------------------------------------------
    describe("retrofit wiring sanity", () => {
        before(() => setEnforcementEnabled(true));
        after(() => setEnforcementEnabled(false));

        test("ForbiddenError is the concrete error type surfaced by the denied handler paths", async () => {
            const { requireResource } = require("../../server/security/authz");
            const { teamIdLoader } = require("../../server/security/team-id-loaders");

            const page = await createStatusPage(teamA, "sanity-status-page");

            await assert.rejects(
                requireResource(
                    ownerActorFor(userB, teamB),
                    "status_page:manage",
                    "status_page",
                    page.id,
                    teamIdLoader
                ),
                ForbiddenError
            );
        });
    });
});
