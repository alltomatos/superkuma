const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { io: ioClient } = require("socket.io-client");

const REPO_ROOT = path.join(__dirname, "..", "..");
const PORT = 30099;

let serverProcess;
let dataDir;
let childOutput = "";

/**
 * Wait until the given TCP port accepts a connection, or reject after a timeout.
 * @param {number} port The port to probe
 * @param {number} timeoutMs Max time to wait
 * @returns {Promise<void>} Resolves once the port is reachable
 */
function waitForPort(port, timeoutMs) {
    const net = require("node:net");
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        (function attempt() {
            const socket = net.createConnection(port, "127.0.0.1");
            socket.once("connect", () => {
                socket.destroy();
                resolve();
            });
            socket.once("error", () => {
                socket.destroy();
                if (Date.now() > deadline) {
                    reject(new Error(`Server never started listening on port ${port}`));
                } else {
                    setTimeout(attempt, 200);
                }
            });
        })();
    });
}

/**
 * Connect a fresh socket.io-client to the test server and emit "setup".
 * @param {string} username Username to attempt
 * @param {string} password Password to attempt
 * @returns {Promise<object>} The setup callback's response
 */
function attemptSetup(username, password) {
    return new Promise((resolve, reject) => {
        const socket = ioClient(`http://127.0.0.1:${PORT}`, { transports: ["websocket"], forceNew: true });
        socket.once("connect_error", reject);
        socket.once("connect", () => {
            socket.emit("setup", username, password, (res) => {
                socket.disconnect();
                resolve(res);
            });
        });
    });
}

describe("setup rate limit (GAP-008)", () => {
    before(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "superkuma-setup-ratelimit-"));

        serverProcess = spawn(process.execPath, ["server/server.js"], {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                NODE_ENV: "development",
                DATA_DIR: dataDir + path.sep,
                SUPERKUMA_PORT: String(PORT),
                SUPERKUMA_DB_TYPE: "sqlite",
                SUPERKUMA_HIDE_LOG: "info_db",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        // Capture the child's output so a boot failure surfaces the real cause
        // (a crash log) instead of an opaque "never started listening".
        serverProcess.stdout.on("data", (chunk) => {
            childOutput += chunk;
        });
        serverProcess.stderr.on("data", (chunk) => {
            childOutput += chunk;
        });
        serverProcess.on("exit", (code, signal) => {
            childOutput += `\n[child exited: code=${code} signal=${signal}]`;
        });

        // A full cold boot (DB init + migrations) is heavy and competes for CPU
        // with the rest of the parallel backend suite, so allow generous time.
        try {
            await waitForPort(PORT, 90000);
        } catch (e) {
            throw new Error(`${e.message}\n--- server child output ---\n${childOutput}`);
        }
        // Give the server a brief moment past the open port to finish its
        // async bootstrap (DB init, migrations) before the first socket connects.
        await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    after(async () => {
        if (serverProcess) {
            serverProcess.kill();
            // Wait for the child to actually exit and release its SQLite file
            // handle before deleting the data dir -- Windows holds an exclusive
            // lock while the process is alive, which would otherwise throw
            // EBUSY on rmSync.
            await once(serverProcess, "exit").catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (dataDir) {
            try {
                fs.rmSync(dataDir, { recursive: true, force: true });
            } catch (e) {
                // Best-effort cleanup: a lingering OS lock on the unique
                // mkdtemp dir is harmless, so never fail the suite over it.
                void e;
            }
        }
    });

    test("rapid setup attempts beyond the token budget are rate-limited", async () => {
        // loginRateLimiter is configured with tokensPerInterval: 20, fireImmediately: true
        // (server/rate-limiter.js) -- all 20 tokens are available up front, so 21 rapid,
        // back-to-back attempts should deterministically exhaust the budget on the 21st,
        // no real time delay needed.
        const results = [];
        for (let i = 0; i < 21; i++) {
            // eslint-disable-next-line no-await-in-loop -- must be strictly sequential to
            // guarantee the 21st request is really the 21st against the shared token bucket
            results.push(await attemptSetup(`setup-flood-user-${i}`, "not-a-real-password-123"));
        }

        const rateLimited = results.filter((r) => r && r.msg === "Too frequently, try again later.");
        assert.ok(
            rateLimited.length > 0,
            "at least one of the 21 rapid setup attempts must be rejected by the rate limiter"
        );
    });
});
