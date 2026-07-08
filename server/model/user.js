const { BeanModel } = require("redbean-node/dist/bean-model");
const passwordHash = require("../password-hash");
const { R } = require("redbean-node");
const jwt = require("jsonwebtoken");
const { shake256, SHAKE256_LENGTH } = require("../util-server");

class User extends BeanModel {
    /**
     * Reset user password
     * Fix #1510, as in the context reset-password.js, there is no auto model mapping. Call this static function instead.
     * @param {number} userID ID of user to update
     * @param {string} newPassword Users new password
     * @returns {Promise<void>}
     */
    static async resetPassword(userID, newPassword) {
        await R.exec("UPDATE `user` SET password = ? WHERE id = ? ", [
            await passwordHash.generate(newPassword),
            userID,
        ]);
    }

    /**
     * Reset this users password
     * @param {string} newPassword Users new password
     * @returns {Promise<void>}
     */
    async resetPassword(newPassword) {
        const hashedPassword = await passwordHash.generate(newPassword);

        await R.exec("UPDATE `user` SET password = ? WHERE id = ? ", [hashedPassword, this.id]);

        this.password = hashedPassword;
    }

    /**
     * Create a new JWT for a user.
     * Adds `sub` (user id) and `tv` (token version, for revocation) claims plus
     * an optional expiry. `h` (password hash) is kept so a password change keeps
     * invalidating existing tokens.
     * @param {User} user The User to create a JsonWebToken for
     * @param {string} jwtSecret The key used to sign the JsonWebToken
     * @param {number} expiresInSeconds Token lifetime in seconds; 0 = no expiry
     * @returns {string} the JsonWebToken as a string
     */
    static createJWT(user, jwtSecret, expiresInSeconds = 0) {
        const payload = {
            username: user.username,
            h: shake256(user.password, SHAKE256_LENGTH),
            sub: String(user.id),
            tv: user.token_version || 0,
        };
        const options = {};
        if (expiresInSeconds > 0) {
            options.expiresIn = expiresInSeconds;
        }
        return jwt.sign(payload, jwtSecret, options);
    }

    /**
     * Create a signed JWT applying the configured expiry (the `jwtExpiryHours`
     * setting; 0 or unset = no expiry, preserving legacy behaviour).
     * @param {User} user The User to create a JsonWebToken for
     * @param {string} jwtSecret The key used to sign the JsonWebToken
     * @returns {Promise<string>} the JsonWebToken as a string
     */
    static async createSignedToken(user, jwtSecret) {
        const { Settings } = require("../settings");
        const hours = Number(await Settings.get("jwtExpiryHours")) || 0;
        return User.createJWT(user, jwtSecret, hours * 3600);
    }

    /**
     * Increment a user's token version, invalidating all their existing JWTs.
     * Called from setUserSuperadmin's demotion path (alongside an immediate
     * live-socket disconnect) so a stale/replayed JWT can't be used to regain
     * a revoked superadmin's privileges.
     * @param {number} userID The user whose tokens to revoke
     * @returns {Promise<void>}
     */
    static async bumpTokenVersion(userID) {
        await R.exec("UPDATE `user` SET token_version = token_version + 1 WHERE id = ? ", [userID]);
    }
}

module.exports = User;
