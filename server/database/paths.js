const fs = require("fs");
const path = require("path");
const { log, isDev } = require("../../src/util");

/**
 * Initialize the data directory
 * @param {object} args Arguments to initialize DB with
 * @param {object} Database The Database class whose static path properties should be populated
 * @returns {void}
 */
function initDataDir(args, Database) {
    // Data Directory (must be end with "/")
    Database.dataDir = process.env.DATA_DIR || args["data-dir"] || getDevDataDir() || "./data/";

    Database.sqlitePath = path.join(Database.dataDir, "kuma.db");
    if (!fs.existsSync(Database.dataDir)) {
        fs.mkdirSync(Database.dataDir, { recursive: true });
    }

    Database.uploadDir = path.join(Database.dataDir, "upload/");

    if (!fs.existsSync(Database.uploadDir)) {
        fs.mkdirSync(Database.uploadDir, { recursive: true });
    }

    // Create screenshot dir
    Database.screenshotDir = path.join(Database.dataDir, "screenshots/");
    if (!fs.existsSync(Database.screenshotDir)) {
        fs.mkdirSync(Database.screenshotDir, { recursive: true });
    }

    Database.dockerTLSDir = path.join(Database.dataDir, "docker-tls/");
    if (!fs.existsSync(Database.dockerTLSDir)) {
        fs.mkdirSync(Database.dockerTLSDir, { recursive: true });
    }

    log.info("server", `Data Dir: ${Database.dataDir}`);
}

/**
 * Development + non-master branch + no custom only
 * To avoid database migration issue during different pull request testing.
 * Path: ./data/dev-data/<git branch name>/
 * @returns {string} The dev data dir, empty string if not in dev mode or in master branch
 */
function getDevDataDir() {
    if (isDev) {
        const gitBranch = getCurrentGitBranch();

        // HEAD means detached head. Don't handle this case, becasuse it is not common.
        if (gitBranch !== "" && gitBranch !== "master" && gitBranch !== "HEAD") {
            log.info("server", `Using development data directory for branch ${gitBranch}`);
            return path.join("./data/dev-data/", gitBranch, "/");
        } else {
            log.debug("server", "Do not use development data directory because it is master branch");
        }
    }
    return "";
}

/**
 * Get the current git branch name
 * @returns {string} The current git branch name, or empty string if it cannot be determined
 */
function getCurrentGitBranch() {
    try {
        const { execSync } = require("child_process");
        // Reference: https://stackoverflow.com/questions/6245570/how-do-i-get-the-current-branch-name-in-git
        return execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
    } catch (e) {
        return "";
    }
}

module.exports = {
    initDataDir,
    getDevDataDir,
    getCurrentGitBranch,
};
