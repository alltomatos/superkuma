const { describe, test } = require("node:test");
const assert = require("node:assert");
const { TCPMonitorType } = require("../../../server/monitor-types/tcp");
const { UP, PENDING } = require("../../../src/util");
const net = require("net");

describe("TCP Monitor", () => {
    /**
     * Creates a TCP server on a specified port
     * @param {number} port - The port number to listen on
     * @returns {Promise<net.Server>} A promise that resolves with the created server
     */
    async function createTCPServer(port) {
        return new Promise((resolve, reject) => {
            const server = net.createServer();

            server.listen(port, () => {
                resolve(server);
            });

            server.on("error", (err) => {
                reject(err);
            });
        });
    }

    test("check() sets status to UP when TCP server is reachable", async () => {
        const port = 12345;
        const server = await createTCPServer(port);

        try {
            const tcpMonitor = new TCPMonitorType();

            const monitor = {
                hostname: "localhost",
                port: port,
                isEnabledExpiryNotification: () => false,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            await tcpMonitor.check(monitor, heartbeat, {});

            assert.strictEqual(heartbeat.status, UP);
        } finally {
            server.close();
        }
    });

    test("check() rejects with connection failed when TCP server is not running", async () => {
        const tcpMonitor = new TCPMonitorType();

        const monitor = {
            hostname: "localhost",
            port: 54321,
            isEnabledExpiryNotification: () => false,
        };

        const heartbeat = {
            msg: "",
            status: PENDING,
        };

        await assert.rejects(tcpMonitor.check(monitor, heartbeat, {}), new Error("Connection failed"));
    });

    test("parseTlsAlertNumber() extracts alert number from error message", async () => {
        const { parseTlsAlertNumber } = require("../../../server/monitor-types/tcp");

        // Test various error message formats
        assert.strictEqual(parseTlsAlertNumber("alert number 116"), 116);
        assert.strictEqual(parseTlsAlertNumber("SSL alert number 42"), 42);
        assert.strictEqual(parseTlsAlertNumber("TLS alert number 48"), 48);
        assert.strictEqual(parseTlsAlertNumber("no alert here"), null);
        assert.strictEqual(parseTlsAlertNumber(""), null);
    });

    test("getTlsAlertName() returns correct alert name for known codes", async () => {
        const { getTlsAlertName } = require("../../../server/monitor-types/tcp");

        assert.strictEqual(getTlsAlertName(116), "certificate_required");
        assert.strictEqual(getTlsAlertName(42), "bad_certificate");
        assert.strictEqual(getTlsAlertName(48), "unknown_ca");
        assert.strictEqual(getTlsAlertName(40), "handshake_failure");
        assert.strictEqual(getTlsAlertName(999), "unknown_alert_999");
    });
});
