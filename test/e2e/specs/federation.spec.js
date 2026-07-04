import { expect, test } from "@playwright/test";
import { execFileSync } from "child_process";
import path from "path";
import { login, restoreSqliteSnapshot, screenshot } from "../util-test";

const dbPath = path.resolve(__dirname, "../../../data/playwright-test/kuma.db");

/**
 * Run a statement directly against the e2e sqlite database via the
 * `sqlite3` CLI, returning stdout (trimmed). Used ONLY to seed/inspect state
 * that has no UI/API path yet (a monitor's remote_instance_id is only ever
 * set by the federation heartbeat ingestion pipeline, never by a user
 * through the UI). The app keeps the database in WAL mode, which safely
 * supports this kind of short-lived external writer alongside the running
 * server.
 * @param {string} sql SQL statement to execute
 * @returns {string} Trimmed stdout of the sqlite3 CLI invocation
 */
function runSqlite(sql) {
    return execFileSync("sqlite3", [dbPath, sql]).toString().trim();
}

test.describe("Federation", () => {
    test.beforeEach(async ({ page }) => {
        await restoreSqliteSnapshot(page);
    });

    test("add and delete a remote instance", async ({ page }, testInfo) => {
        const instanceName = "Client A";
        const instanceId = "client-a";

        await page.goto("./settings/federation");
        await login(page);

        await expect(page.getByText("No Remote Instances")).toBeVisible();

        // Add a remote instance
        await page.getByRole("button", { name: "Add Remote Instance" }).click();
        await page.locator("#remote-instance-name").fill(instanceName);
        await page.locator("#remote-instance-id").fill(instanceId);
        await screenshot(testInfo, page);
        await page.locator("button[type=submit]", { hasText: "Add Remote Instance" }).click();

        // The one-time token modal should appear with a well-formed token
        const tokenModal = page.locator(".modal", { hasText: "Remote Instance Added" });
        const tokenInput = tokenModal.locator("input[type=text]");
        await expect(tokenInput).toBeVisible();
        const token = await tokenInput.inputValue();
        expect(token).toMatch(/^ri\d+_.+/);
        await screenshot(testInfo, page);

        await page.getByRole("button", { name: "Continue" }).click();

        // It should now be listed
        await expect(page.getByText(instanceName)).toBeVisible();
        await expect(page.getByText(instanceId)).toBeVisible();

        // Delete it
        await page.getByRole("button", { name: "Delete" }).click();
        await page.getByRole("button", { name: "Yes" }).click();

        await expect(page.getByText("No Remote Instances")).toBeVisible();
        await expect(page.getByText(instanceName)).toHaveCount(0);
        await screenshot(testInfo, page);
    });

    test("saving agent config does not clobber unrelated general settings", async ({ page }, testInfo) => {
        const unrelatedBaseURL = "https://unrelated-setting-should-survive.example.com";
        const masterUrl = "https://master.example.com";
        const federationInstanceId = "agent-1";
        const federationToken = "ri1_someclearsecrettoken";

        // Set an unrelated general setting first
        await page.goto("./settings/general");
        await login(page);
        const primaryBaseURLInput = page.locator("#primaryBaseURL").first();
        await primaryBaseURLInput.fill(unrelatedBaseURL);
        await page.getByRole("button", { name: "Save" }).click();
        await expect(primaryBaseURLInput).toHaveValue(unrelatedBaseURL);

        // Now go to Federation and save the agent config fields
        await page.goto("./settings/federation");
        await page.locator("#federationMasterUrl").fill(masterUrl);
        await page.locator("#federationInstanceId").fill(federationInstanceId);
        // HiddenInput.vue doesn't forward the `id` prop to its inner <input>;
        // Vue's fallthrough attrs put it on the wrapping div instead.
        await page.locator("#federationToken input").fill(federationToken);
        await screenshot(testInfo, page);
        await page.locator("form", { hasText: "Master URL" }).getByRole("button", { name: "Save" }).click();

        // Reload and confirm the federation fields persisted
        await page.goto("./settings/federation");
        await expect(page.locator("#federationMasterUrl")).toHaveValue(masterUrl);
        await expect(page.locator("#federationInstanceId")).toHaveValue(federationInstanceId);

        // Confirm the unrelated general setting was NOT clobbered
        await page.goto("./settings/general");
        await expect(page.locator("#primaryBaseURL").first()).toHaveValue(unrelatedBaseURL);
        await screenshot(testInfo, page);
    });

    test("monitor list shows a badge with the remote instance name", async ({ page }, testInfo) => {
        const instanceName = "Client B";
        const instanceId = "client-b";
        const monitorName = "Federated Monitor";

        // Register a remote instance through the real UI/socket flow, so we
        // exercise the same path a user would and get back a real id.
        await page.goto("./settings/federation");
        await login(page);
        await page.getByRole("button", { name: "Add Remote Instance" }).click();
        await page.locator("#remote-instance-name").fill(instanceName);
        await page.locator("#remote-instance-id").fill(instanceId);
        await page.locator("button[type=submit]", { hasText: "Add Remote Instance" }).click();
        await expect(
            page.locator(".modal", { hasText: "Remote Instance Added" }).locator("input[type=text]")
        ).toBeVisible();
        await page.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByText(instanceName)).toBeVisible();

        // Create a normal monitor via the UI (push type, closest to how a
        // mirrored federated monitor actually behaves).
        await page.goto("./add");
        await expect(page.getByTestId("monitor-type-select")).toBeVisible();
        await page.getByTestId("monitor-type-select").selectOption("push");
        await page.getByTestId("friendly-name-input").fill(monitorName);
        await page.getByTestId("save-button").click();
        await page.waitForURL("/dashboard/*");

        // There is intentionally no UI/API to set monitor.remote_instance_id
        // directly (it's only ever written by the federation heartbeat
        // ingestion pipeline in server/routers/federation-router.js, which we
        // must not modify/exercise here). Seed it directly via sqlite to
        // simulate what that pipeline would have done, so we can verify the
        // frontend badge renders correctly.
        const remoteInstanceId = runSqlite(`SELECT id FROM remote_instance WHERE instance_id = '${instanceId}';`);
        expect(remoteInstanceId).toMatch(/^\d+$/);
        runSqlite(`UPDATE monitor SET remote_instance_id = ${remoteInstanceId} WHERE name = '${monitorName}';`);

        // A full reload is required to pick up the sqlite-seeded monitor
        // change (monitorList is only pushed once on socket connect). The
        // badge resolves the remote instance name purely client-side from
        // $root.remoteInstanceList, which (by design, see MonitorListItem.vue)
        // is only populated once the Federation settings page has been
        // visited in the current session -- so after the reload we navigate
        // there via normal in-app (SPA) navigation, then back to the
        // dashboard the same way, without any further full page reload.
        await page.reload();
        await page.locator(".dropdown-profile-pic .nav-link").click();
        await page.getByRole("link", { name: "Settings" }).click();
        await page.waitForURL("**/settings/**");
        await page.getByRole("link", { name: "Federation" }).click();
        await page.waitForURL("**/settings/federation");
        await expect(page.locator(".title", { hasText: instanceName })).toBeVisible();

        await page.getByRole("link", { name: "Dashboard" }).click();
        await page.waitForURL("**/dashboard");
        await screenshot(testInfo, page);

        const monitorItem = page.locator(".item", { hasText: monitorName });
        await expect(monitorItem.getByText(instanceName)).toBeVisible();
    });
});
