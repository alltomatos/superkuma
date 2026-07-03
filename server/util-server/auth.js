const { R } = require("redbean-node");
const { genSecret } = require("../../src/util");
const passwordHash = require("../password-hash");
const oidc = require("openid-client");

/**
 * Init or reset JWT secret
 * @returns {Promise<Bean>} JWT secret
 */
exports.initJWTSecret = async () => {
    let jwtSecretBean = await R.findOne("setting", " `key` = ? ", ["jwtSecret"]);

    if (!jwtSecretBean) {
        jwtSecretBean = R.dispense("setting");
        jwtSecretBean.key = "jwtSecret";
    }

    jwtSecretBean.value = await passwordHash.generate(genSecret());
    await R.store(jwtSecretBean);
    return jwtSecretBean;
};

/**
 * Decodes a jwt and returns the payload portion without verifying the jwt.
 * @param {string} jwt The input jwt as a string
 * @returns {object} Decoded jwt payload object
 */
exports.decodeJwt = (jwt) => {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
};

/**
 * Gets an Access Token from an oidc/oauth2 provider
 * @param {string} tokenEndpoint The token URI from the auth service provider
 * @param {string} clientId The oidc/oauth application client id
 * @param {string} clientSecret The oidc/oauth application client secret
 * @param {string} scope The scope(s) for which the token should be issued for
 * @param {string} audience The audience for which the token should be issued for
 * @param {string} authMethod The method used to send the credentials. Default client_secret_basic
 * @returns {Promise<oidc.TokenSet>} TokenSet promise if the token request was successful
 */
exports.getOidcTokenClientCredentials = async (
    tokenEndpoint,
    clientId,
    clientSecret,
    scope,
    audience,
    authMethod = "client_secret_basic"
) => {
    const oauthProvider = new oidc.Issuer({ token_endpoint: tokenEndpoint });
    let client = new oauthProvider.Client({
        client_id: clientId,
        client_secret: clientSecret,
        token_endpoint_auth_method: authMethod,
    });

    // Increase default timeout and clock tolerance
    client[oidc.custom.http_options] = () => ({ timeout: 10000 });
    client[oidc.custom.clock_tolerance] = 5;

    let grantParams = { grant_type: "client_credentials" };
    if (scope) {
        grantParams.scope = scope;
    }

    if (audience) {
        grantParams.audience = audience;
    }
    return await client.grant(grantParams);
};

/**
 * Check if a user is logged in
 * @param {Socket} socket Socket instance
 * @returns {void}
 * @throws The user is not logged in
 */
exports.checkLogin = (socket) => {
    if (!socket.userID) {
        throw new Error("You are not logged in.");
    }
};

/**
 * For logged-in users, double-check the password
 * @param {Socket} socket Socket.io instance
 * @param {string} currentPassword Password to validate
 * @returns {Promise<Bean>} User
 * @throws The current password is not a string
 * @throws The provided password is not correct
 */
exports.doubleCheckPassword = async (socket, currentPassword) => {
    if (typeof currentPassword !== "string") {
        throw new Error("Wrong data type?");
    }

    let user = await R.findOne("user", " id = ? AND active = 1 ", [socket.userID]);

    if (!user || !passwordHash.verify(currentPassword, user.password)) {
        throw new Error("Incorrect current password");
    }

    return user;
};
