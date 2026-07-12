const basicAuth = require("express-basic-auth");
const passwordHash = require("./password-hash");
const { R } = require("redbean-node");
const { log } = require("../src/util");
const { loginRateLimiter, apiRateLimiter } = require("./rate-limiter");
const { Settings } = require("./settings");
const dayjs = require("dayjs");

// A fixed, valid bcrypt hash with no matching real password -- comparing
// against it when `user` is null keeps login() at a roughly constant time
// cost regardless of whether `username` refers to a real user, closing a
// user-enumeration timing side channel (GAP-008): without this, a
// nonexistent username used to short-circuit before the (slow) bcrypt
// compare ever ran, making the response measurably faster than for an
// existing username with a wrong password.
const DUMMY_HASH = "$2a$10$poL4RBvb6EtkR3X98XRdOum6Zd.4F8DFLdATQnPuEdGoixYFoFaPW";

/**
 * Login to web app
 * @param {string} username Username to login with
 * @param {string} password Password to login with
 * @returns {Promise<(Bean|null)>} User or null if login failed
 */
exports.login = async function (username, password) {
    if (typeof username !== "string" || typeof password !== "string") {
        return null;
    }

    let user = await R.findOne("user", "TRIM(username) = ? AND active = 1 ", [username.trim()]);
    let passwordMatches = passwordHash.verify(password, user ? user.password : DUMMY_HASH);

    if (user && passwordMatches) {
        // Upgrade the hash to bcrypt
        if (passwordHash.needRehash(user.password)) {
            await R.exec("UPDATE `user` SET password = ? WHERE id = ? ", [
                await passwordHash.generate(password),
                user.id,
            ]);
        }
        return user;
    }

    return null;
};

/**
 * Validate a provided API key
 * @param {string} key API key to verify
 * @returns {Promise<(object|boolean)>} The api_key bean if valid, otherwise false
 */
async function verifyAPIKey(key) {
    if (typeof key !== "string") {
        return false;
    }

    // uk prefix + key ID is before _
    let index = key.substring(2, key.indexOf("_"));
    let clear = key.substring(key.indexOf("_") + 1, key.length);

    let hash = await R.findOne("api_key", " id=? ", [index]);

    if (hash === null) {
        return false;
    }

    let current = dayjs();
    let expiry = dayjs(hash.expires);
    if (expiry.diff(current) < 0 || !hash.active) {
        return false;
    }

    // Return the bean itself (not just a boolean) so callers can build a
    // permission-scoped actor from it (ADR-0010 P2/§8.4).
    return passwordHash.verify(clear, hash.key) ? hash : false;
}

// Exposed so the Socket.io `loginByApiKey` handler (headless/MCP agents) can
// authenticate a socket session with the same API key it would use for the
// HTTP `/metrics` basic-auth path, reusing the identical hash/expiry/active
// checks instead of duplicating them.
exports.verifyAPIKey = verifyAPIKey;

/**
 * Validate a provided remote instance (federation agent) token
 * @param {string} token Remote instance token to verify
 * @returns {Promise<(object|false)>} The remote_instance bean if valid, otherwise false
 */
exports.verifyRemoteInstanceToken = async function (token) {
    if (typeof token !== "string") {
        return false;
    }

    // ri prefix + remote_instance ID is before _
    let index = token.substring(2, token.indexOf("_"));
    let clear = token.substring(token.indexOf("_") + 1, token.length);

    let remoteInstance = await R.findOne("remote_instance", " id = ? ", [index]);

    if (remoteInstance === null) {
        return false;
    }

    if (!remoteInstance.active) {
        return false;
    }

    return passwordHash.verify(clear, remoteInstance.token_hash) ? remoteInstance : false;
};

/**
 * Callback for basic auth authorizers
 * @callback authCallback
 * @param {any} err Any error encountered
 * @param {boolean} authorized Is the client authorized?
 */

/**
 * Custom authorizer for express-basic-auth
 * @param {string} username Username to login with
 * @param {string} password Password to login with
 * @param {authCallback} callback Callback to handle login result
 * @returns {void}
 */
function apiAuthorizer(username, password, callback) {
    // API Rate Limit
    apiRateLimiter.pass(null, 0).then((pass) => {
        if (pass) {
            verifyAPIKey(password).then((valid) => {
                if (!valid) {
                    log.warn("api-auth", "Failed API auth attempt: invalid API Key");
                }
                callback(null, Boolean(valid));
                // Only allow a set number of api requests per minute
                // (currently set to 60)
                apiRateLimiter.removeTokens(1);
            });
        } else {
            log.warn("api-auth", "Failed API auth attempt: rate limit exceeded");
            callback(null, false);
        }
    });
}

/**
 * Custom authorizer for express-basic-auth
 * @param {string} username Username to login with
 * @param {string} password Password to login with
 * @param {authCallback} callback Callback to handle login result
 * @returns {void}
 */
function userAuthorizer(username, password, callback) {
    // Login Rate Limit
    loginRateLimiter.pass(null, 0).then((pass) => {
        if (pass) {
            exports.login(username, password).then((user) => {
                callback(null, user != null);

                if (user == null) {
                    log.warn("basic-auth", "Failed basic auth attempt: invalid username/password");
                    loginRateLimiter.removeTokens(1);
                }
            });
        } else {
            log.warn("basic-auth", "Failed basic auth attempt: rate limit exceeded");
            callback(null, false);
        }
    });
}

/**
 * Use basic auth if auth is not disabled
 * @param {express.Request} req Express request object
 * @param {express.Response} res Express response object
 * @param {express.NextFunction} next Next handler in chain
 * @returns {Promise<void>}
 */
exports.basicAuth = async function (req, res, next) {
    const middleware = basicAuth({
        authorizer: userAuthorizer,
        authorizeAsync: true,
        challenge: true,
    });

    const disabledAuth = await Settings.get("disableAuth");

    if (!disabledAuth) {
        middleware(req, res, next);
    } else {
        next();
    }
};

/**
 * Use use API Key if API keys enabled, else use basic auth
 * @param {express.Request} req Express request object
 * @param {express.Response} res Express response object
 * @param {express.NextFunction} next Next handler in chain
 * @returns {Promise<void>}
 */
exports.apiAuth = async function (req, res, next) {
    if (!(await Settings.get("disableAuth"))) {
        let usingAPIKeys = await Settings.get("apiKeysEnabled");
        let middleware;
        if (usingAPIKeys) {
            middleware = basicAuth({
                authorizer: apiAuthorizer,
                authorizeAsync: true,
                challenge: true,
            });
        } else {
            middleware = basicAuth({
                authorizer: userAuthorizer,
                authorizeAsync: true,
                challenge: true,
            });
        }
        middleware(req, res, next);
    } else {
        next();
    }
};

/**
 * Resolve an RBAC actor for the current HTTP request and attach it as
 * `req.actor` (ADR-0010 phase P4). Must run AFTER `apiAuth`/`basicAuth` have
 * already authenticated the request -- it mirrors the exact same auth
 * strategy (disableAuth / API key / basic auth) to determine WHO was just
 * authenticated, since express-basic-auth's authorizer callback has no access
 * to `req` to attach anything directly.
 *
 * Under `disableAuth`, there is no per-request credential to re-verify, so the
 * actor is resolved deterministically from the same lowest-id active user
 * that socket.js's own auto-login path uses (ADR-0010 R12) -- keeping
 * `disableAuth` installs working exactly as before for anything gated by
 * `req.actor` (e.g. the `/metrics` endpoint).
 *
 * Never throws: on any resolution failure, `req.actor` is left `null` so
 * downstream gates fail closed.
 * @param {express.Request} req Express request object
 * @param {express.Response} res Express response object
 * @param {express.NextFunction} next Next handler in chain
 * @returns {Promise<void>}
 */
exports.attachActor = async function (req, res, next) {
    req.actor = null;
    try {
        const { buildActorForUser, buildActorForApiKey } = require("./security/actor-repository");

        if (await Settings.get("disableAuth")) {
            const user = await R.findOne("user", " active = 1 ORDER BY id ASC ");
            if (user) {
                req.actor = await buildActorForUser(user);
            }
        } else if (req.auth && typeof req.auth.user === "string" && typeof req.auth.pass === "string") {
            const usingAPIKeys = await Settings.get("apiKeysEnabled");
            if (usingAPIKeys) {
                const keyBean = await verifyAPIKey(req.auth.pass);
                if (keyBean) {
                    req.actor = await buildActorForApiKey(keyBean);
                }
            } else {
                const user = await exports.login(req.auth.user, req.auth.pass);
                if (user) {
                    req.actor = await buildActorForUser(user);
                }
            }
        }
    } catch (e) {
        log.warn("auth", "attachActor: failed to resolve an actor, leaving req.actor null: " + e.message);
    }
    next();
};

/**
 * Reject the request unless the resolved req.actor (attached by attachActor,
 * which must run earlier in the middleware chain) is a super admin
 * (ADR-0010 D9 -- e.g. the /metrics endpoint, whose data is process-wide and
 * not team-scoped).
 * @param {express.Request} req Express request object
 * @param {express.Response} res Express response object
 * @param {express.NextFunction} next Next handler in chain
 * @returns {void}
 */
exports.requireSuperadmin = function (req, res, next) {
    if (req.actor && req.actor.isSuperadmin) {
        next();
    } else {
        res.status(403).json({
            ok: false,
            msg: "Super admin required.",
        });
    }
};
