/*
 * SuperKuma Server
 * node "server/server.js"
 * DO NOT require("./server") in other modules, it likely creates circular dependency!
 */
console.log("Welcome to SuperKuma");

// As the log function need to use dayjs, it should be very top
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("./modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

// Load environment variables from `.env`
require("dotenv").config();

// Check Node.js Version
const nodeVersion = process.versions.node;

// Get the required Node.js version from package.json
const requiredNodeVersions = require("../package.json").engines.node;
const bannedNodeVersions = " < 18 || 20.0.* || 20.1.* || 20.2.* || 20.3.* ";
console.log(`Your Node.js version: ${nodeVersion}`);

const semver = require("semver");
const requiredNodeVersionsComma = requiredNodeVersions
    .split("||")
    .map((version) => version.trim())
    .join(", ");

// Exit SuperKuma immediately if the Node.js version is banned
if (semver.satisfies(nodeVersion, bannedNodeVersions)) {
    console.error(
        "\x1b[31m%s\x1b[0m",
        `Error: Your Node.js version: ${nodeVersion} is not supported, please upgrade your Node.js to ${requiredNodeVersionsComma}.`
    );
    process.exit(-1);
}

// Warning if the Node.js version is not in the support list, but it maybe still works
if (!semver.satisfies(nodeVersion, requiredNodeVersions)) {
    console.warn(
        "\x1b[31m%s\x1b[0m",
        `Warning: Your Node.js version: ${nodeVersion} is not officially supported, please upgrade your Node.js to ${requiredNodeVersionsComma}.`
    );
}

const args = require("args-parser")(process.argv);
const { sleep, log, getRandomInt, genSecret, isDev } = require("../src/util");
const config = require("./config");

process.title = "superkuma";

log.debug("server", "Arguments");
log.debug("server", args);

if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = "production";
}

if (!process.env.SUPERKUMA_WS_ORIGIN_CHECK) {
    process.env.SUPERKUMA_WS_ORIGIN_CHECK = "cors-like";
}

log.info("server", "Env: " + process.env.NODE_ENV);
log.debug("server", "Inside Container: " + (process.env.SUPERKUMA_IS_CONTAINER === "1"));

if (process.env.SUPERKUMA_WS_ORIGIN_CHECK === "bypass") {
    log.warn("server", "WebSocket Origin Check: " + process.env.SUPERKUMA_WS_ORIGIN_CHECK);
}

if (isDev || process.env.SUPERKUMA_DEBUG_INSPECTOR === "1") {
    const inspector = require("inspector");
    let inspectorHost = "127.0.0.1";

    log.warn("server", "Node.js Inspector is enabled. You can connect to it via Chrome DevTools or VSCode.");
    log.warn("server", "Node.js Inspector is listening on:", inspector.url());

    if (process.env.SUPERKUMA_IS_CONTAINER === "1") {
        log.warn(
            "server",
            "You need to expose the port 9229:9229 in your docker command or docker compose, and ssh tunneling in order to connect to it."
        );
        inspectorHost = "0.0.0.0";
    }

    inspector.open(9229, inspectorHost);
}

const checkVersion = require("./check-version");
log.info("server", "SuperKuma Version:", checkVersion.version);

log.info("server", "Loading modules");

log.debug("server", "Importing express");
const express = require("express");
const expressStaticGzip = require("express-static-gzip");
log.debug("server", "Importing redbean-node");
const { R } = require("redbean-node");
log.debug("server", "Importing jsonwebtoken");
const jwt = require("jsonwebtoken");
log.debug("server", "Importing http-graceful-shutdown");
const gracefulShutdown = require("http-graceful-shutdown");
log.debug("server", "Importing prometheus-api-metrics");
const prometheusAPIMetrics = require("prometheus-api-metrics");
const { passwordStrength } = require("check-password-strength");
const TranslatableError = require("./translatable-error");

log.debug("server", "Importing 2FA Modules");
const notp = require("notp");
const base32 = require("thirty-two");

const { SuperKumaServer } = require("./superkuma-server");
const server = SuperKumaServer.getInstance();
const io = (module.exports.io = server.io);
const app = server.app;

log.debug("server", "Importing Monitor");
const Monitor = require("./model/monitor");
const User = require("./model/user");

log.debug("server", "Importing Settings");
const {
    getSettings,
    setSettings,
    setting,
    initJWTSecret,
    checkLogin,
    doubleCheckPassword,
    shake256,
    SHAKE256_LENGTH,
    allowDevAllOrigin,
    printServerUrls,
} = require("./util-server");

log.debug("server", "Importing Notification");
const { Notification } = require("./notification");
Notification.init();

const { requireResource, ForbiddenError } = require("./security/authz");
const { teamIdLoader } = require("./security/team-id-loaders");
log.debug("server", "Importing Web-Push");
const webpush = require("web-push");

log.debug("server", "Importing Database");
const Database = require("./database");

log.debug("server", "Importing Background Jobs");
const { initBackgroundJobs, stopBackgroundJobs } = require("./jobs");
const { loginRateLimiter, twoFaRateLimiter } = require("./rate-limiter");

const { apiAuth, attachActor, requireSuperadmin } = require("./auth");
const { login, verifyAPIKey } = require("./auth");
const passwordHash = require("./password-hash");

const { Prometheus } = require("./prometheus");
const { UptimeCalculator } = require("./uptime-calculator");

const hostname = config.hostname;

if (hostname) {
    log.info("server", "Custom hostname: " + hostname);
}

const port = config.port;

const disableFrameSameOrigin =
    !!process.env.SUPERKUMA_DISABLE_FRAME_SAMEORIGIN || args["disable-frame-sameorigin"] || false;
const cloudflaredToken = args["cloudflared-token"] || process.env.SUPERKUMA_CLOUDFLARED_TOKEN || undefined;

// 2FA / notp verification defaults
const twoFAVerifyOptions = {
    window: 1,
    time: 30,
};

/**
 * Run unit test after the server is ready
 * @type {boolean}
 */
const testMode = !!args["test"] || false;

// Must be after io instantiation
const {
    sendNotificationList,
    sendHeartbeatList,
    sendInfo,
    sendProxyList,
    sendDockerHostList,
    sendAPIKeyList,
    sendRemoteBrowserList,
    sendMonitorTypeList,
} = require("./client");
const { statusPageSocketHandler } = require("./socket-handlers/status-page-socket-handler");
const { databaseSocketHandler } = require("./socket-handlers/database-socket-handler");
const { remoteBrowserSocketHandler } = require("./socket-handlers/remote-browser-socket-handler");
const TwoFA = require("./2fa");
const StatusPage = require("./model/status_page");
const {
    cloudflaredSocketHandler,
    autoStart: cloudflaredAutoStart,
    stop: cloudflaredStop,
} = require("./socket-handlers/cloudflared-socket-handler");
const { proxySocketHandler } = require("./socket-handlers/proxy-socket-handler");
const { dockerSocketHandler } = require("./socket-handlers/docker-socket-handler");
const { maintenanceSocketHandler } = require("./socket-handlers/maintenance-socket-handler");
const { apiKeySocketHandler } = require("./socket-handlers/api-key-socket-handler");
const { remoteInstanceSocketHandler } = require("./socket-handlers/remote-instance-socket-handler");
const { userSocketHandler } = require("./socket-handlers/user-socket-handler");
const { teamSocketHandler } = require("./socket-handlers/team-socket-handler");
const { notificationRouteSocketHandler } = require("./socket-handlers/notification-route-socket-handler");
const { dashboardSocketHandler } = require("./socket-handlers/dashboard-socket-handler");
const { mailSocketHandler } = require("./socket-handlers/mail-socket-handler");
const { generalSocketHandler } = require("./socket-handlers/general-socket-handler");
const { monitorSocketHandler } = require("./socket-handlers/monitor-socket-handler");
const { Settings } = require("./settings");
const { resetChrome } = require("./monitor-types/real-browser-monitor-type");
const { EmbeddedMariaDB } = require("./embedded-mariadb");
const { SetupDatabase } = require("./setup-database");
const { chartSocketHandler } = require("./socket-handlers/chart-socket-handler");

// Global JSON body parser -- every route EXCEPT POST /v1/metrics (the OTLP
// telemetry receiver, server/routers/telemetry-router.js, ADR-0015
// TASK-A2-4), which registers its OWN size-limited json/raw parsers so its
// declared payload cap is the one actually enforced (see
// server/middleware/path-excluded-json-parser.js for why the exclusion is
// necessary and for this exact mechanism's own unit tests). Every OTHER
// route's behavior is byte-for-byte identical to plain `express.json()`.
const { pathExcludedJsonParser } = require("./middleware/path-excluded-json-parser");
app.use(pathExcludedJsonParser(["/v1/metrics"]));

// Global Middleware
app.use(function (req, res, next) {
    if (!disableFrameSameOrigin) {
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
    }
    res.removeHeader("X-Powered-By");
    next();
});

/**
 * Show Setup Page
 * @type {boolean}
 */
let needSetup = false;

(async () => {
    // Create a data directory
    Database.initDataDir(args);

    // Check if is chosen a database type
    let setupDatabase = new SetupDatabase(args, server);
    if (setupDatabase.isNeedSetup()) {
        // Hold here and start a special setup page until user choose a database type
        await setupDatabase.start(hostname, port);
    }

    // Connect to database
    try {
        await initDatabase(testMode);
    } catch (e) {
        log.error("server", "Failed to prepare your database: " + e.message);
        process.exit(1);
    }

    // Database should be ready now
    await server.initAfterDatabaseReady();
    server.entryPage = await Settings.get("entryPage");
    await StatusPage.loadDomainMappingList();

    log.debug("server", "Initializing Prometheus");
    await Prometheus.init();

    log.debug("server", "Adding route");

    // ***************************
    // Normal Router here
    // ***************************

    // Entry Page
    app.get("/", async (request, response) => {
        let hostname = request.hostname;
        if (await setting("trustProxy")) {
            const proxy = request.headers["x-forwarded-host"];
            if (proxy) {
                hostname = proxy;
            }
        }

        log.debug("entry", `Request Domain: ${hostname}`);

        const superKumaEntryPage = server.entryPage;
        if (hostname in StatusPage.domainMappingList) {
            log.debug("entry", "This is a status page domain");

            let slug = StatusPage.domainMappingList[hostname];
            await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
        } else if (superKumaEntryPage && superKumaEntryPage.startsWith("statusPage-")) {
            response.redirect("/status/" + superKumaEntryPage.replace("statusPage-", ""));
        } else {
            response.redirect("/dashboard");
        }
    });

    app.get("/setup-database-info", (request, response) => {
        allowDevAllOrigin(response);
        response.json({
            runningSetup: false,
            needSetup: false,
        });
    });

    if (isDev) {
        app.use(express.urlencoded({ extended: true }));
        app.post("/test-webhook", async (request, response) => {
            log.debug("test", request.headers);
            log.debug("test", request.body);
            response.send("OK");
        });

        app.post("/test-x-www-form-urlencoded", async (request, response) => {
            log.debug("test", request.headers);
            log.debug("test", request.body);
            response.send("OK");
        });

        const fs = require("fs");

        app.get("/_e2e/take-sqlite-snapshot", async (request, response) => {
            await Database.close();
            try {
                fs.cpSync(Database.sqlitePath, `${Database.sqlitePath}.e2e-snapshot`);
            } catch (err) {
                throw new Error("Unable to copy SQLite DB.");
            }
            await Database.connect();

            response.send("Snapshot taken.");
        });

        app.get("/_e2e/restore-sqlite-snapshot", async (request, response) => {
            if (!fs.existsSync(`${Database.sqlitePath}.e2e-snapshot`)) {
                throw new Error("Snapshot doesn't exist.");
            }

            await Database.close();
            try {
                fs.cpSync(`${Database.sqlitePath}.e2e-snapshot`, Database.sqlitePath);
            } catch (err) {
                throw new Error("Unable to copy snapshot file.");
            }
            await Database.connect();

            response.send("Snapshot restored.");
        });
    }

    // Robots.txt
    app.get("/robots.txt", async (_request, response) => {
        let txt = "User-agent: *\nDisallow:";
        if (!(await setting("searchEngineIndex"))) {
            txt += " /";
        }
        response.setHeader("Content-Type", "text/plain");
        response.send(txt);
    });

    // Basic Auth Router here

    // Prometheus API metrics  /metrics
    // With Basic Auth using the first user's username/password
    // ADR-0010 D9: gated to super admins only. Metrics are process-wide
    // singletons (not team-scoped), so any authenticated user seeing them
    // would see every team's data -- until a per-team metrics registry
    // exists, restrict to the one role that is already meant to see
    // everything.
    app.get("/metrics", apiAuth, attachActor, requireSuperadmin, prometheusAPIMetrics());

    app.use(
        "/",
        expressStaticGzip("dist", {
            enableBrotli: true,
        })
    );

    // ./data/upload
    app.use("/upload", express.static(Database.uploadDir));

    app.get("/.well-known/change-password", async (_, response) => {
        response.redirect("https://github.com/alltomatos/superkuma/wiki/Reset-Password-via-CLI");
    });

    // API Router
    const apiRouter = require("./routers/api-router");
    app.use(apiRouter);

    // Status Page Router
    const statusPageRouter = require("./routers/status-page-router");
    app.use(statusPageRouter);

    // Public Dashboard Router (ADR-0017: published /dashboards/:slug + data API)
    const dashboardRouter = require("./routers/dashboard-router");
    app.use(dashboardRouter);

    // Federation Router
    const federationRouter = require("./routers/federation-router");
    app.use(federationRouter);

    // Telemetry Router (OTLP/JSON metrics receiver, ADR-0015)
    const telemetryRouter = require("./routers/telemetry-router");
    app.use(telemetryRouter);

    // Embedded HTTP MCP endpoint (/mcp). Disabled unless SUPERKUMA_MCP_HTTP_ENABLED=true.
    const mcpRouter = require("./routers/mcp-router");
    app.use(mcpRouter);

    // Universal Route Handler, must be at the end of all express routes.
    app.get("*", async (_request, response) => {
        if (_request.originalUrl.startsWith("/upload/")) {
            response.status(404).send("File not found.");
        } else {
            response.send(server.indexHTML);
        }
    });

    log.debug("server", "Adding socket handler");
    io.on("connection", async (socket) => {
        await sendInfo(socket, true);

        if (needSetup) {
            log.info("server", "Redirect to setup page");
            socket.emit("setup");
        }

        // ***************************
        // Public Socket API
        // ***************************

        socket.on("loginByToken", async (token, callback) => {
            const clientIP = await server.getClientIP(socket);

            log.info("auth", `Login by token. IP=${clientIP}`);

            try {
                let decoded = jwt.verify(token, server.jwtSecret);

                log.info("auth", "Username from JWT: " + decoded.username);

                let user = await R.findOne("user", " username = ? AND active = 1 ", [decoded.username]);

                if (user) {
                    // Check if the password changed
                    if (decoded.h !== shake256(user.password, SHAKE256_LENGTH)) {
                        throw new Error("The token is invalid due to password change or old token");
                    }

                    // Grandfather tokens issued before token_version existed as v0 (ADR-0010 R6).
                    if ((decoded.tv ?? 0) !== (user.token_version ?? 0)) {
                        throw new Error("The token has been revoked");
                    }

                    log.debug("auth", "afterLogin");
                    await afterLogin(socket, user);
                    log.debug("auth", "afterLogin ok");

                    log.info("auth", `Successfully logged in user ${decoded.username}. IP=${clientIP}`);

                    callback({
                        ok: true,
                    });
                } else {
                    log.info("auth", `Inactive or deleted user ${decoded.username}. IP=${clientIP}`);

                    callback({
                        ok: false,
                        msg: "authUserInactiveOrDeleted",
                        msgi18n: true,
                    });
                }
            } catch (error) {
                log.error("auth", `Invalid token. IP=${clientIP}`);
                if (error.message) {
                    log.error("auth", error.message, `IP=${clientIP}`);
                }
                callback({
                    ok: false,
                    msg: "authInvalidToken",
                    msgi18n: true,
                });
            }
        });

        socket.on("login", async (data, callback) => {
            const clientIP = await server.getClientIP(socket);

            log.info("auth", `Login by username + password. IP=${clientIP}`);

            // Checking
            if (typeof callback !== "function") {
                return;
            }

            if (!data) {
                return;
            }

            // Login Rate Limit
            if (!(await loginRateLimiter.pass(callback))) {
                log.info("auth", `Too many failed requests for user ${data.username}. IP=${clientIP}`);
                return;
            }

            let user = await login(data.username, data.password);

            if (user) {
                if (user.twofa_status === 0) {
                    await afterLogin(socket, user);

                    log.info("auth", `Successfully logged in user ${data.username}. IP=${clientIP}`);

                    callback({
                        ok: true,
                        token: await User.createSignedToken(user, server.jwtSecret),
                    });
                }

                if (user.twofa_status === 1 && !data.token) {
                    log.info("auth", `2FA token required for user ${data.username}. IP=${clientIP}`);

                    callback({
                        tokenRequired: true,
                    });
                }

                if (data.token) {
                    let verify = notp.totp.verify(data.token, user.twofa_secret, twoFAVerifyOptions);

                    if (user.twofa_last_token !== data.token && verify) {
                        await afterLogin(socket, user);

                        await R.exec("UPDATE `user` SET twofa_last_token = ? WHERE id = ? ", [
                            data.token,
                            socket.userID,
                        ]);

                        log.info("auth", `Successfully logged in user ${data.username}. IP=${clientIP}`);

                        callback({
                            ok: true,
                            token: await User.createSignedToken(user, server.jwtSecret),
                        });
                    } else {
                        log.warn("auth", `Invalid token provided for user ${data.username}. IP=${clientIP}`);

                        callback({
                            ok: false,
                            msg: "authInvalidToken",
                            msgi18n: true,
                        });
                    }
                }
            } else {
                log.warn("auth", `Incorrect username or password for user ${data.username}. IP=${clientIP}`);

                callback({
                    ok: false,
                    msg: "authIncorrectCreds",
                    msgi18n: true,
                });
            }
        });

        // Headless login for automation/agents (e.g. the SuperKuma MCP server).
        // Authenticates a socket session with an existing API key (uk<id>_<secret>)
        // instead of a username/password, so the agent never holds a plaintext
        // password and access can be revoked/expired per key. Reuses verifyAPIKey
        // (the same check as the /metrics HTTP path) and scopes the session to the
        // key's own role/team via buildActorForApiKey (ADR-0010 R2).
        socket.on("loginByApiKey", async (apiKey, callback) => {
            const clientIP = await server.getClientIP(socket);

            log.info("auth", `Login by API key. IP=${clientIP}`);

            if (typeof callback !== "function") {
                return;
            }

            // Reuse the password-login rate limiter to throttle brute-force attempts.
            if (!(await loginRateLimiter.pass(callback))) {
                log.info("auth", `Too many failed login requests. IP=${clientIP}`);
                return;
            }

            try {
                const keyBean = await verifyAPIKey(apiKey);

                if (!keyBean) {
                    log.warn("auth", `Invalid API key. IP=${clientIP}`);
                    loginRateLimiter.removeTokens(1);
                    callback({
                        ok: false,
                        msg: "authInvalidToken",
                        msgi18n: true,
                    });
                    return;
                }

                const user = await R.findOne("user", " id = ? AND active = 1 ", [keyBean.user_id]);

                if (!user) {
                    log.info("auth", `API key owner inactive or deleted. IP=${clientIP}`);
                    callback({
                        ok: false,
                        msg: "authUserInactiveOrDeleted",
                        msgi18n: true,
                    });
                    return;
                }

                const { buildActorForApiKey } = require("./security/actor-repository");
                const actor = await buildActorForApiKey(keyBean);

                await afterLogin(socket, user, actor);

                log.info("auth", `Successfully logged in via API key. User=${user.username} IP=${clientIP}`);

                callback({
                    ok: true,
                });
            } catch (error) {
                log.error("auth", `API key login error. IP=${clientIP}`);
                if (error.message) {
                    log.error("auth", error.message, `IP=${clientIP}`);
                }
                callback({
                    ok: false,
                    msg: "authInvalidToken",
                    msgi18n: true,
                });
            }
        });

        socket.on("logout", async (callback) => {
            // Rate Limit
            if (!(await loginRateLimiter.pass(callback))) {
                return;
            }

            socket.leave(socket.userID);
            socket.userID = null;

            if (typeof callback === "function") {
                callback();
            }
        });

        socket.on("prepare2FA", async (currentPassword, callback) => {
            try {
                if (!(await twoFaRateLimiter.pass(callback))) {
                    return;
                }

                checkLogin(socket);
                await doubleCheckPassword(socket, currentPassword);

                let user = await R.findOne("user", " id = ? AND active = 1 ", [socket.userID]);

                if (user.twofa_status === 0) {
                    let newSecret = genSecret();
                    let encodedSecret = base32.encode(newSecret);

                    // Google authenticator doesn't like equal signs
                    // The fix is found at https://github.com/guyht/notp
                    // Related issue: https://github.com/alltomatos/superkuma/issues/486
                    encodedSecret = encodedSecret.toString().replace(/=/g, "");

                    let uri = `otpauth://totp/Uptime%20Kuma:${user.username}?secret=${encodedSecret}`;

                    await R.exec("UPDATE `user` SET twofa_secret = ? WHERE id = ? ", [newSecret, socket.userID]);

                    callback({
                        ok: true,
                        uri: uri,
                    });
                } else {
                    callback({
                        ok: false,
                        msg: "2faAlreadyEnabled",
                        msgi18n: true,
                    });
                }
            } catch (error) {
                callback({
                    ok: false,
                    msg: error.message,
                });
            }
        });

        socket.on("save2FA", async (currentPassword, callback) => {
            const clientIP = await server.getClientIP(socket);

            try {
                if (!(await twoFaRateLimiter.pass(callback))) {
                    return;
                }

                checkLogin(socket);
                await doubleCheckPassword(socket, currentPassword);

                await R.exec("UPDATE `user` SET twofa_status = 1 WHERE id = ? ", [socket.userID]);

                log.info("auth", `Saved 2FA token. IP=${clientIP}`);

                callback({
                    ok: true,
                    msg: "2faEnabled",
                    msgi18n: true,
                });
            } catch (error) {
                log.error("auth", `Error changing 2FA token. IP=${clientIP}`);

                callback({
                    ok: false,
                    msg: error.message,
                });
            }
        });

        socket.on("disable2FA", async (currentPassword, callback) => {
            const clientIP = await server.getClientIP(socket);

            try {
                if (!(await twoFaRateLimiter.pass(callback))) {
                    return;
                }

                checkLogin(socket);
                await doubleCheckPassword(socket, currentPassword);
                await TwoFA.disable2FA(socket.userID);

                log.info("auth", `Disabled 2FA token. IP=${clientIP}`);

                callback({
                    ok: true,
                    msg: "2faDisabled",
                    msgi18n: true,
                });
            } catch (error) {
                log.error("auth", `Error disabling 2FA token. IP=${clientIP}`);

                callback({
                    ok: false,
                    msg: error.message,
                });
            }
        });

        socket.on("verifyToken", async (token, currentPassword, callback) => {
            try {
                checkLogin(socket);
                await doubleCheckPassword(socket, currentPassword);

                let user = await R.findOne("user", " id = ? AND active = 1 ", [socket.userID]);

                let verify = notp.totp.verify(token, user.twofa_secret, twoFAVerifyOptions);

                if (user.twofa_last_token !== token && verify) {
                    callback({
                        ok: true,
                        valid: true,
                    });
                } else {
                    callback({
                        ok: false,
                        msg: "authInvalidToken",
                        msgi18n: true,
                        valid: false,
                    });
                }
            } catch (error) {
                callback({
                    ok: false,
                    msg: error.message,
                });
            }
        });

        socket.on("twoFAStatus", async (callback) => {
            try {
                checkLogin(socket);

                let user = await R.findOne("user", " id = ? AND active = 1 ", [socket.userID]);

                if (user.twofa_status === 1) {
                    callback({
                        ok: true,
                        status: true,
                    });
                } else {
                    callback({
                        ok: true,
                        status: false,
                    });
                }
            } catch (error) {
                callback({
                    ok: false,
                    msg: error.message,
                });
            }
        });

        socket.on("needSetup", async (callback) => {
            callback(needSetup);
        });

        socket.on("setup", async (username, password, callback) => {
            // Setup Rate Limit (GAP-008): reuse the same login limiter so a
            // socket cannot flood the setup event, e.g. to race the
            // count-check/insert below.
            if (!(await loginRateLimiter.pass(callback))) {
                return;
            }

            try {
                if (passwordStrength(password).value === "Too weak") {
                    throw new TranslatableError("passwordTooWeak");
                }

                if ((await R.knex("user").count("id as count").first()).count !== 0) {
                    throw new Error(
                        "SuperKuma has been initialized. If you want to run setup again, please delete the database."
                    );
                }

                let user = R.dispense("user");
                user.username = username;
                user.password = await passwordHash.generate(password);
                // ADR-0010: the P1 migration's backfill only promotes the lowest-id
                // user to superadmin + Default Team owner for installs that already
                // had a user row at migration time. A brand-new install has no user
                // yet when migrations run, so the setup wizard must grant the same
                // standing here -- otherwise this account would hold zero RBAC
                // permissions the moment enforcement is ever turned on.
                user.is_superadmin = true;
                await R.store(user);

                const defaultTeam = await R.knex("team").where("slug", "default").first();
                const ownerRole = await R.knex("role").whereNull("team_id").andWhere("slug", "owner").first();
                if (defaultTeam && ownerRole) {
                    await R.knex("team_user").insert({
                        team_id: defaultTeam.id,
                        user_id: user.id,
                        role_id: ownerRole.id,
                    });
                }

                needSetup = false;

                callback({
                    ok: true,
                    msg: "successAdded",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                    msgi18n: !!e.msgi18n,
                });
            }
        });

        // ***************************
        // Auth Only API
        // ***************************

        socket.on("changePassword", async (password, callback) => {
            try {
                checkLogin(socket);

                if (!password.newPassword) {
                    throw new Error("Invalid new password");
                }

                if (passwordStrength(password.newPassword).value === "Too weak") {
                    throw new TranslatableError("passwordTooWeak");
                }

                let user = await doubleCheckPassword(socket, password.currentPassword);
                await user.resetPassword(password.newPassword);

                server.disconnectAllSocketClients(user.id, socket.id);

                callback({
                    ok: true,
                    token: await User.createSignedToken(user, server.jwtSecret),
                    msg: "successAuthChangePassword",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                    msgi18n: !!e.msgi18n,
                });
            }
        });

        socket.on("getSettings", async (callback) => {
            try {
                checkLogin(socket);
                const data = await getSettings("general");

                if (!data.serverTimezone) {
                    data.serverTimezone = await server.getTimezone();
                }

                callback({
                    ok: true,
                    data: data,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("setSettings", async (data, currentPassword, callback) => {
            try {
                checkLogin(socket);

                // If currently is disabled auth, don't need to check
                // Disabled Auth + Want to Disable Auth => No Check
                // Disabled Auth + Want to Enable Auth => No Check
                // Enabled Auth + Want to Disable Auth => Check!!
                // Enabled Auth + Want to Enable Auth => No Check
                const currentDisabledAuth = await setting("disableAuth");
                if (!currentDisabledAuth && data.disableAuth) {
                    await doubleCheckPassword(socket, currentPassword);
                }

                // Log out all clients if enabling auth
                // GHSA-23q2-5gf8-gjpp
                if (currentDisabledAuth && !data.disableAuth) {
                    server.disconnectAllSocketClients(socket.userID, socket.id);
                }

                const previousChromeExecutable = await Settings.get("chromeExecutable");
                const previousNSCDStatus = await Settings.get("nscd");

                await setSettings("general", data);
                server.entryPage = data.entryPage;

                // Also need to apply timezone globally
                if (data.serverTimezone) {
                    await server.setTimezone(data.serverTimezone);
                }

                // If Chrome Executable is changed, need to reset the browser
                if (previousChromeExecutable !== data.chromeExecutable) {
                    log.info("settings", "Chrome executable is changed. Resetting Chrome...");
                    await resetChrome();
                }

                // Update nscd status
                if (previousNSCDStatus !== data.nscd) {
                    if (data.nscd) {
                        await server.startNSCDServices();
                    } else {
                        await server.stopNSCDServices();
                    }
                }

                callback({
                    ok: true,
                    msg: "Saved.",
                    msgi18n: true,
                });

                await sendInfo(socket);
                await server.sendMaintenanceList(socket);
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        // Add or Edit
        socket.on("addNotification", async (notification, notificationID, callback) => {
            try {
                checkLogin(socket);

                let notificationBean = await Notification.save(
                    notification,
                    notificationID,
                    socket.userID,
                    socket.actor
                );
                await sendNotificationList(socket);

                callback({
                    ok: true,
                    msg: "Saved.",
                    msgi18n: true,
                    id: notificationBean.id,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("deleteNotification", async (notificationID, callback) => {
            try {
                checkLogin(socket);

                await Notification.delete(notificationID, socket.userID, socket.actor);
                await sendNotificationList(socket);

                callback({
                    ok: true,
                    msg: "successDeleted",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("testNotification", async (notification, callback) => {
            try {
                checkLogin(socket);

                let msg = await Notification.send(notification, notification.name + " Testing");

                callback({
                    ok: true,
                    msg,
                });
            } catch (e) {
                log.error("server", e);

                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("checkApprise", async (callback) => {
            try {
                checkLogin(socket);
                callback(await Notification.checkApprise());
            } catch (e) {
                callback(false);
            }
        });

        socket.on("getWebpushVapidPublicKey", async (callback) => {
            try {
                let publicVapidKey = await Settings.get("webpushPublicVapidKey");

                if (!publicVapidKey) {
                    log.debug("webpush", "Generating new VAPID keys");
                    const vapidKeys = webpush.generateVAPIDKeys();

                    await Settings.set("webpushPublicVapidKey", vapidKeys.publicKey);
                    await Settings.set("webpushPrivateVapidKey", vapidKeys.privateKey);

                    publicVapidKey = vapidKeys.publicKey;
                }

                callback({
                    ok: true,
                    msg: publicVapidKey,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("clearEvents", async (monitorID, callback) => {
            try {
                checkLogin(socket);
                await requireResource(socket.actor, "monitor:manage_state", "monitor", monitorID, teamIdLoader);

                log.info("manage", `Clear Events Monitor: ${monitorID} User ID: ${socket.userID}`);

                await R.exec("UPDATE heartbeat SET msg = ?, important = ? WHERE monitor_id = ? ", ["", "0", monitorID]);

                callback({
                    ok: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("clearHeartbeats", async (monitorID, callback) => {
            try {
                checkLogin(socket);
                await requireResource(socket.actor, "monitor:manage_state", "monitor", monitorID, teamIdLoader);

                log.info("manage", `Clear Heartbeats Monitor: ${monitorID} User ID: ${socket.userID}`);

                await UptimeCalculator.clearStatistics(monitorID);

                if (monitorID in server.monitorList) {
                    const monitor = server.monitorList[monitorID];
                    if (monitor.active) {
                        await restartMonitor(socket.userID, monitorID);
                    }
                }

                await sendHeartbeatList(socket, monitorID, true, true);

                callback({
                    ok: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("clearStatistics", async (callback) => {
            try {
                checkLogin(socket);
                // Global, instance-wide action (wipes every monitor's stats, not
                // just the actor's own team) -- no team-scoped permission fits, so
                // this is superadmin-only, matching other truly-global actions
                // (createTeam, setUserSuperadmin).
                if (!(socket.actor && socket.actor.isSuperadmin)) {
                    throw new ForbiddenError("Only a superadmin can clear statistics for every monitor.");
                }

                log.info("manage", `Clear Statistics User ID: ${socket.userID}`);

                await UptimeCalculator.clearAllStatistics();

                // Restart all monitors to reset the stats
                for (let monitorID in server.monitorList) {
                    const monitor = server.monitorList[monitorID];
                    if (monitor.active) {
                        await restartMonitor(socket.userID, monitorID);
                    }
                }

                callback({
                    ok: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        // Status Page Socket Handler for admin only
        statusPageSocketHandler(socket);
        cloudflaredSocketHandler(socket);
        databaseSocketHandler(socket);
        proxySocketHandler(socket);
        dockerSocketHandler(socket);
        maintenanceSocketHandler(socket);
        apiKeySocketHandler(socket);
        remoteInstanceSocketHandler(socket);
        remoteBrowserSocketHandler(socket);
        userSocketHandler(socket, server);
        teamSocketHandler(socket);
        notificationRouteSocketHandler(socket);
        dashboardSocketHandler(socket);
        mailSocketHandler(socket);
        generalSocketHandler(socket, server);
        chartSocketHandler(socket);
        monitorSocketHandler(socket, server, {
            startMonitor,
            restartMonitor,
            pauseMonitor,
            updateMonitorNotification,
        });

        log.debug("server", "added all socket handlers");

        // ***************************
        // Better do anything after added all socket handlers here
        // ***************************

        log.debug("auth", "check auto login");
        if (await setting("disableAuth")) {
            log.info("auth", "Disabled Auth: auto login to admin");
            // Deterministic auto-login (ADR-0010 R12): lowest-id active user
            // (which the backfill made the super admin), not a plan-dependent row.
            await afterLogin(socket, await R.findOne("user", " active = 1 ORDER BY id ASC "));
            socket.emit("autoLogin");
        } else {
            socket.emit("loginRequired");
            log.debug("auth", "need auth");
        }
    });

    log.debug("server", "Init the server");

    server.httpServer.once("error", async (err) => {
        log.error("server", "Cannot listen: " + err.message);
        await shutdownFunction();
        process.exit(1);
    });

    await server.start();

    server.httpServer.listen(port, hostname, async () => {
        printServerUrls("server", port, hostname, config.isSSL);

        await startMonitors();

        // Put this here. Start background jobs after the db and server is ready to prevent clear up during db migration.
        await initBackgroundJobs();

        checkVersion.startInterval();
    });

    // Start cloudflared at the end if configured
    await cloudflaredAutoStart(cloudflaredToken);
})();

/**
 * Update notifications for a given monitor
 * @param {number} monitorID ID of monitor to update
 * @param {number[]} notificationIDList List of new notification
 * providers to add
 * @param {object} actor The RBAC actor performing the update. Each linked
 * notification is validated to belong to the actor's team before being
 * linked, closing the cross-tenant hole where a client could link a monitor
 * to a notification it does not own (ADR-0010 §4.4).
 * @returns {Promise<void>}
 */
async function updateMonitorNotification(monitorID, notificationIDList, actor) {
    await R.exec("DELETE FROM monitor_notification WHERE monitor_id = ? ", [monitorID]);

    for (let notificationID in notificationIDList) {
        if (notificationIDList[notificationID]) {
            await requireResource(actor, "notification:read", "notification", notificationID, teamIdLoader);
            let relation = R.dispense("monitor_notification");
            relation.monitor_id = monitorID;
            relation.notification_id = notificationID;
            await R.store(relation);
        }
    }
}

/**
 * Check if a given user owns a specific monitor
 * @param {number} userID ID of user to check
 * @param {number} monitorID ID of monitor to check
 * @returns {Promise<void>}
 * @throws {Error} The specified user does not own the monitor
 */
async function checkOwner(userID, monitorID) {
    let row = await R.getRow("SELECT id FROM monitor WHERE id = ? AND user_id = ? ", [monitorID, userID]);

    if (!row) {
        throw new Error("You do not own this monitor.");
    }
}

/**
 * Function called after user login
 * This function is used to send the heartbeat list of a monitor.
 * @param {Socket} socket Socket.io instance
 * @param {object} user User object
 * @param {object} actorOverride Pre-built RBAC actor to attach instead of the
 * user's full actor. Used by the `loginByApiKey` path to scope the session to
 * the API key's own role/team (least-privilege, ADR-0010 R2). Defaults to null,
 * preserving the original behaviour for password/token logins.
 * @returns {Promise<void>}
 */
async function afterLogin(socket, user, actorOverride = null) {
    socket.userID = user.id;

    // ADR-0010: attach the RBAC actor + permission payload. Must never break login.
    try {
        const { buildActorForUser, buildPermissionPayload } = require("./security/actor-repository");
        socket.actor = actorOverride || (await buildActorForUser(user));
        socket.permissionPayload = await buildPermissionPayload(user, socket.actor);
    } catch (e) {
        // Fall back to a minimal actor carrying the correct userId (never null)
        // with empty memberships, so it fails closed (denies everything) rather
        // than crashing login -- the safe default when the real actor can't be built.
        const { buildActor } = require("./security/authz");
        socket.actor = buildActor({ userId: user.id, isSuperadmin: false }, []);
        socket.permissionPayload = null;
        log.warn("auth", "RBAC actor build failed, falling back to a fail-closed actor: " + e.message);
    }

    // ADR-0010: join the room AFTER the actor is resolved, since roomFor()
    // needs socket.actor.activeTeamId to route correctly.
    const { roomFor } = require("./security/rooms");
    socket.join(roomFor(user.id, socket.actor.activeTeamId));

    let monitorList = await server.sendMonitorList(socket);
    await Promise.allSettled([
        sendInfo(socket),
        server.sendMaintenanceList(socket),
        sendNotificationList(socket),
        sendProxyList(socket),
        sendDockerHostList(socket),
        sendAPIKeyList(socket),
        sendRemoteBrowserList(socket),
        sendMonitorTypeList(socket),
    ]);

    await StatusPage.sendStatusPageList(io, socket);

    const monitorPromises = [];
    for (let monitorID in monitorList) {
        monitorPromises.push(sendHeartbeatList(socket, monitorID));
        monitorPromises.push(Monitor.sendStats(io, monitorID, user.id));
    }

    await Promise.all(monitorPromises);

    // Set server timezone from client browser if not set
    // It should be run once only
    if (!(await Settings.get("initServerTimezone"))) {
        log.debug("server", "emit initServerTimezone");
        socket.emit("initServerTimezone");
    }
}

/**
 * Initialize the database
 * @param {boolean} testMode Should the connection be
 * started in test mode?
 * @returns {Promise<void>}
 */
async function initDatabase(testMode = false) {
    log.debug("server", "Connecting to the database");
    await Database.connect(testMode);
    log.info("server", "Connected to the database");

    // Patch the database
    await Database.patch(port, hostname);

    let jwtSecretBean = await R.findOne("setting", " `key` = ? ", ["jwtSecret"]);

    if (!jwtSecretBean) {
        log.info("server", "JWT secret is not found, generate one.");
        jwtSecretBean = await initJWTSecret();
        log.info("server", "Stored JWT secret into database");
    } else {
        log.debug("server", "Load JWT secret from database.");
    }

    // If there is no record in user table, it is a new SuperKuma instance, need to setup
    if ((await R.knex("user").count("id as count").first()).count === 0) {
        log.info("server", "No user, need setup");
        needSetup = true;
    }

    server.jwtSecret = jwtSecretBean.value;
}

/**
 * Start the specified monitor
 * @param {number} userID ID of user who owns monitor
 * @param {number} monitorID ID of monitor to start
 * @returns {Promise<void>}
 */
async function startMonitor(userID, monitorID) {
    await checkOwner(userID, monitorID);

    log.info("manage", `Resume Monitor: ${monitorID} User ID: ${userID}`);

    await R.exec("UPDATE monitor SET active = 1 WHERE id = ? AND user_id = ? ", [monitorID, userID]);

    let monitor = await R.findOne("monitor", " id = ? ", [monitorID]);

    if (monitor.id in server.monitorList) {
        await server.monitorList[monitor.id].stop();
    }

    server.monitorList[monitor.id] = monitor;
    await monitor.start(io);
}

/**
 * Restart a given monitor
 * @param {number} userID ID of user who owns monitor
 * @param {number} monitorID ID of monitor to start
 * @returns {Promise<void>}
 */
async function restartMonitor(userID, monitorID) {
    return await startMonitor(userID, monitorID);
}

/**
 * Pause a given monitor
 * @param {number} userID ID of user who owns monitor
 * @param {number} monitorID ID of monitor to start
 * @returns {Promise<void>}
 */
async function pauseMonitor(userID, monitorID) {
    await checkOwner(userID, monitorID);

    log.info("manage", `Pause Monitor: ${monitorID} User ID: ${userID}`);

    await R.exec("UPDATE monitor SET active = 0 WHERE id = ? AND user_id = ? ", [monitorID, userID]);

    if (monitorID in server.monitorList) {
        await server.monitorList[monitorID].stop();
        server.monitorList[monitorID].active = 0;
    }
}

/**
 * Resume active monitors
 * @returns {Promise<void>}
 */
async function startMonitors() {
    let list = await R.find("monitor", " active = 1 ");

    for (let monitor of list) {
        server.monitorList[monitor.id] = monitor;
    }

    for (let monitor of list) {
        try {
            await monitor.start(io);
        } catch (e) {
            log.error("monitor", e);
        }
        // Give some delays, so all monitors won't make request at the same moment when just start the server.
        await sleep(getRandomInt(300, 1000));
    }
}

/**
 * Shutdown the application
 * Stops all monitors and closes the database connection.
 * @param {string} signal The signal that triggered this function to be called.
 * @returns {Promise<void>}
 */
async function shutdownFunction(signal) {
    log.info("server", "Shutdown requested");
    log.info("server", "Called signal: " + signal);

    await server.stop();

    log.info("server", "Stopping all monitors");
    for (let id in server.monitorList) {
        let monitor = server.monitorList[id];
        await monitor.stop();
    }
    await sleep(2000);
    await Database.close();

    if (EmbeddedMariaDB.hasInstance()) {
        EmbeddedMariaDB.getInstance().stop();
    }

    stopBackgroundJobs();
    await cloudflaredStop();
    Settings.stopCacheCleaner();
}

/**
 * Final function called before application exits
 * @returns {void}
 */
function finalFunction() {
    log.info("server", "Graceful shutdown successful!");
}

gracefulShutdown(server.httpServer, {
    signals: "SIGINT SIGTERM",
    timeout: 30000, // timeout: 30 secs
    development: false, // not in dev mode
    forceExit: true, // triggers process.exit() at the end of shutdown process
    onShutdown: shutdownFunction, // shutdown function (async) - e.g. for cleanup DB, ...
    finally: finalFunction, // finally function (sync) - e.g. for logging
});

// Catch unexpected errors here
let unexpectedErrorHandler = (error, promise) => {
    console.trace(error);
    SuperKumaServer.errorLog(error, false);
    console.error("If you keep encountering errors, please report to https://github.com/alltomatos/superkuma/issues");
};
process.addListener("unhandledRejection", unexpectedErrorHandler);
process.addListener("uncaughtException", unexpectedErrorHandler);
