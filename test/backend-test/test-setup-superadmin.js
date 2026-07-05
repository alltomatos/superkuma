process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn, execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const ioClient = require("socket.io-client");

/**
 * The "setup" socket event is registered inline inside server.js's connection
 * handler (not its own module like the other socket-handlers), so it can only
 * be exercised through a real, fully-booted server process -- there is no
 * lighter-weight require-the-module-directly path available for it, unlike
 * every other authz test in this suite.
 */

const PORT = 30099;
const DATA_DIR = path.resolve(__dirname, "../../data/test-setup-superadmin");
const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Poll a URL until it responds (any status code) or the timeout elapses.
 * @param {string} url URL to poll
 * @param {number} timeoutMs Give up after this many milliseconds
 * @returns {Promise<void>} Resolves once the server responds
 */
function waitForServer(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const request = http.get(url, (response) => {
                response.resume();
                resolve();
            });
            request.on("error", () => {
                if (Date.now() > deadline) {
                    reject(new Error(`Server at ${url} did not respond within ${timeoutMs}ms`));
                } else {
                    setTimeout(attempt, 300);
                }
            });
        };
        attempt();
    });
}

describe("setup wizard grants the first user superadmin + Default Team owner (ADR-0010 fix)", () => {
    let serverProcess;

    before(async () => {
        if (fs.existsSync(DATA_DIR)) {
            fs.rmSync(DATA_DIR, { recursive: true, force: true });
        }

        serverProcess = spawn(process.execPath, ["server/server.js", `--port=${PORT}`, `--data-dir=${DATA_DIR}`], {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                NODE_ENV: "development",
                // Bypass the interactive "choose your DB engine" setup-database
                // wizard (an HTTP flow, separate from the "setup" socket event
                // under test here) so the real app boots straight through.
                SUPERKUMA_DB_TYPE: "sqlite",
            },
        });

        await waitForServer(`http://localhost:${PORT}/`, 30000);
    });

    after(async () => {
        if (serverProcess && !serverProcess.killed) {
            serverProcess.kill();
            await new Promise((resolve) => {
                serverProcess.once("exit", resolve);
                setTimeout(resolve, 5000);
            });
        }
        if (fs.existsSync(DATA_DIR)) {
            fs.rmSync(DATA_DIR, { recursive: true, force: true });
        }
    });

    test("emitting 'setup' creates a user who is already superadmin and an owner of Default Team", async () => {
        // The HTTP readiness poll above only proves Express is listening, not
        // that Socket.io's own handshake is ready; under CI/test-suite load the
        // very first WebSocket upgrade attempt can lose that race. Retry a
        // couple of times rather than treating a single transport error as fatal.
        let socket;
        let lastConnectError;
        for (let attempt = 1; attempt <= 3; attempt++) {
            socket = ioClient(`http://localhost:${PORT}`, {
                transports: ["websocket"],
                reconnection: false,
            });
            try {
                await new Promise((resolve, reject) => {
                    socket.once("connect", resolve);
                    socket.once("connect_error", reject);
                });
                lastConnectError = null;
                break;
            } catch (e) {
                lastConnectError = e;
                socket.close();
                await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
            }
        }
        if (lastConnectError) {
            throw lastConnectError;
        }

        const result = await new Promise((resolve) => {
            socket.emit("setup", "setup-test-user", "SetupTestPassw0rd!", resolve);
        });
        assert.strictEqual(result.ok, true, `setup should succeed, got: ${JSON.stringify(result)}`);
        socket.close();

        // The server process still holds the sqlite file open; stop it before
        // inspecting the DB from a separate process to avoid any lock contention.
        serverProcess.kill();
        await new Promise((resolve) => {
            serverProcess.once("exit", resolve);
            setTimeout(resolve, 5000);
        });

        const dbPath = path.join(DATA_DIR, "kuma.db");

        const userRow = execFileSync("sqlite3", [dbPath, "SELECT username, is_superadmin FROM user;"])
            .toString()
            .trim();
        assert.strictEqual(userRow, "setup-test-user|1", "the setup user must be flagged as superadmin");

        const membershipRow = execFileSync("sqlite3", [
            dbPath,
            "SELECT t.slug, r.slug FROM team_user tu " +
                "JOIN team t ON t.id = tu.team_id " +
                "JOIN role r ON r.id = tu.role_id;",
        ])
            .toString()
            .trim();
        assert.strictEqual(membershipRow, "default|owner", "the setup user must own the Default Team");
    });
});
