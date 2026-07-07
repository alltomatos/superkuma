const fs = require("fs");

/**
 * Whether testcontainers-backed tests should be skipped in this environment.
 *
 * These tests spin up real DB/queue/SNMP containers via testcontainers, which
 * needs a reachable Docker daemon. They skip when:
 *   - explicitly opted out (`SKIP_TESTCONTAINERS=1`) -- the escape hatch for a
 *     runner where image pulls are too slow or egress is blocked;
 *   - running on a CI runner that isn't linux/x64 (the only arch these images
 *     are pulled for -- preserves the original guard);
 *   - no Docker daemon is reachable (`DOCKER_HOST` unset AND no
 *     `/var/run/docker.sock`), so a Docker-less runner skips cleanly instead of
 *     erroring on container startup.
 * @returns {boolean} True if the container-backed tests should be skipped.
 */
function skipTestcontainers() {
    if (process.env.SKIP_TESTCONTAINERS === "1") {
        return true;
    }
    if (process.env.CI && (process.platform !== "linux" || process.arch !== "x64")) {
        return true;
    }
    if (process.env.DOCKER_HOST) {
        return false;
    }
    return !fs.existsSync("/var/run/docker.sock");
}

/**
 * Whether tests that reach the live public internet should be skipped.
 *
 * These hit real RDAP/WHOIS servers or external TLS endpoints and so flake on
 * an egress-restricted runner (and some assert hardcoded values that rot over
 * time). They are opt-in on CI: they still run locally by default, but on CI
 * they only run when `RUN_NETWORK_TESTS=1` is set. This keeps CI green and
 * deterministic while preserving the offline portions of each suite.
 * @returns {boolean} True if the live-network tests should be skipped.
 */
function skipNetworkTests() {
    return !!process.env.CI && process.env.RUN_NETWORK_TESTS !== "1";
}

module.exports = { skipTestcontainers, skipNetworkTests };
