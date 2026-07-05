process.env.SUPERKUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");
const { Notification } = require("../../server/notification");
const { buildActor, setEnforcementEnabled, ForbiddenError } = require("../../server/security/authz");
const { teamIdLoader } = require("../../server/security/team-id-loaders");

/**
 * Create a second team + a member actor of it, alongside the Default Team
 * (id `defaultTeamId`) that the RBAC migration's backfill already created.
 * @param {number} defaultTeamId The Default Team's id.
 * @returns {Promise<{teamB: number, actorInDefault: object, actorInTeamB: object}>} Fixtures.
 */
async function makeTwoTeamFixture(defaultTeamId) {
    const ownerRole = await R.knex("role").whereNull("team_id").andWhere("slug", "owner").first();

    // Insert then re-query by a unique column, rather than trust the shape of
    // knex's insert() return value (it varies by driver/dialect) -- same
    // pattern already used by the RBAC migration itself.
    await R.knex("team").insert({ name: "Team B", slug: "team-b", is_system: false, active: true });
    const teamBId = (await R.knex("team").where("slug", "team-b").first()).id;

    await R.knex("user").insert({ username: "default-member", password: "x" });
    const userDefault = (await R.knex("user").where("username", "default-member").first()).id;

    await R.knex("user").insert({ username: "team-b-member", password: "x" });
    const userB = (await R.knex("user").where("username", "team-b-member").first()).id;

    await R.knex("team_user").insert({ team_id: defaultTeamId, user_id: userDefault, role_id: ownerRole.id });
    await R.knex("team_user").insert({ team_id: teamBId, user_id: userB, role_id: ownerRole.id });

    const actorInDefault = buildActor(
        { userId: userDefault, isSuperadmin: false },
        [{ teamId: defaultTeamId, roleSlug: "owner" }],
        defaultTeamId
    );
    const actorInTeamB = buildActor(
        { userId: userB, isSuperadmin: false },
        [{ teamId: teamBId, roleSlug: "owner" }],
        teamBId
    );

    return { teamB: teamBId, actorInDefault, actorInTeamB };
}

describe("server.js / notification.js retrofits (ADR-0010 phase P3)", () => {
    const testDb = new TestDB("./data/test-server-notification-authz");
    let defaultTeamId;
    let fixture;

    before(async () => {
        await testDb.create();
        const team = await R.knex("team").where("slug", "default").first();
        defaultTeamId = team.id;
        fixture = await makeTwoTeamFixture(defaultTeamId);
    });

    after(async () => {
        setEnforcementEnabled(false);
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    describe("monitor:manage_state via requireResource + teamIdLoader (clearEvents/clearHeartbeats call site)", () => {
        let monitorId;

        before(async () => {
            const bean = R.dispense("monitor");
            bean.name = "clear-authz-monitor";
            bean.type = "http";
            bean.url = "https://example.com";
            bean.interval = 60;
            bean.team_id = defaultTeamId;
            monitorId = await R.store(bean);
        });

        test("resolves this monitor's team via the real teamIdLoader", async () => {
            assert.strictEqual(await teamIdLoader("monitor", monitorId), defaultTeamId);
        });

        test("enforcement OFF: never throws for any actor (matches clearEvents/clearHeartbeats' current unguarded behaviour)", async () => {
            const { requireResource } = require("../../server/security/authz");
            await assert.doesNotReject(
                requireResource(fixture.actorInTeamB, "monitor:manage_state", "monitor", monitorId, teamIdLoader)
            );
        });

        test("enforcement ON: a same-team actor may clear it, a cross-team actor is denied", async () => {
            const { requireResource } = require("../../server/security/authz");
            setEnforcementEnabled(true);
            try {
                await assert.doesNotReject(
                    requireResource(fixture.actorInDefault, "monitor:manage_state", "monitor", monitorId, teamIdLoader)
                );
                await assert.rejects(
                    requireResource(fixture.actorInTeamB, "monitor:manage_state", "monitor", monitorId, teamIdLoader),
                    ForbiddenError
                );
            } finally {
                setEnforcementEnabled(false);
            }
        });
    });

    describe("Notification.save/delete actor-based check", () => {
        let notificationId;

        before(async () => {
            const bean = R.dispense("notification");
            bean.name = "clear-authz-notification";
            bean.config = JSON.stringify({ name: "clear-authz-notification", type: "webhook" });
            bean.user_id = fixture.actorInDefault.userId;
            bean.team_id = defaultTeamId;
            bean.active = true;
            bean.is_default = false;
            notificationId = await R.store(bean);
        });

        test("enforcement OFF: save()/delete() behave exactly as before, actor param is inert", async () => {
            const saved = await Notification.save(
                { name: "clear-authz-notification-edited", type: "webhook" },
                notificationId,
                fixture.actorInDefault.userId,
                fixture.actorInTeamB // wrong-team actor passed on purpose: must be a no-op while OFF
            );
            assert.strictEqual(saved.id, notificationId);
        });

        test("enforcement ON: cross-team actor is denied on save(), same-team actor succeeds", async () => {
            setEnforcementEnabled(true);
            try {
                await assert.rejects(
                    Notification.save(
                        { name: "x", type: "webhook" },
                        notificationId,
                        fixture.actorInDefault.userId,
                        fixture.actorInTeamB
                    ),
                    ForbiddenError
                );
                await assert.doesNotReject(
                    Notification.save(
                        { name: "clear-authz-notification-edited-2", type: "webhook" },
                        notificationId,
                        fixture.actorInDefault.userId,
                        fixture.actorInDefault
                    )
                );
            } finally {
                setEnforcementEnabled(false);
            }
        });

        test("enforcement ON: cross-team actor is denied on delete()", async () => {
            setEnforcementEnabled(true);
            try {
                await assert.rejects(
                    Notification.delete(notificationId, fixture.actorInDefault.userId, fixture.actorInTeamB),
                    ForbiddenError
                );
            } finally {
                setEnforcementEnabled(false);
            }
        });
    });

    describe("updateMonitorNotification actor-based FK validation", () => {
        test("enforcement ON: linking a cross-team notification id throws ForbiddenError", async () => {
            const notifBean = R.dispense("notification");
            notifBean.name = "team-b-notification";
            notifBean.config = JSON.stringify({ name: "team-b-notification", type: "webhook" });
            notifBean.user_id = fixture.actorInTeamB.userId;
            notifBean.team_id = fixture.teamB;
            notifBean.active = true;
            notifBean.is_default = false;
            const teamBNotificationId = await R.store(notifBean);

            const { requireResource } = require("../../server/security/authz");
            setEnforcementEnabled(true);
            try {
                await assert.rejects(
                    requireResource(
                        fixture.actorInDefault,
                        "notification:read",
                        "notification",
                        teamBNotificationId,
                        teamIdLoader
                    ),
                    ForbiddenError
                );
            } finally {
                setEnforcementEnabled(false);
            }
        });
    });
});
