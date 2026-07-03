/**
 * Validate a value against a zod schema
 *
 * Existing socket handlers and routers surface errors by catching an
 * Error and reporting `e.message` back to the client (e.g. via
 * `callback({ ok: false, msg: e.message })`). This helper keeps that
 * convention intact for validation failures: it runs `schema.parse()`
 * and, if it fails, rethrows a plain `Error` with a short readable
 * message instead of leaking zod's internal issue array.
 * @param {import("zod").ZodTypeAny} schema Zod schema to validate against
 * @param {unknown} value Value to validate
 * @returns {unknown} The parsed (and possibly coerced) value
 * @throws {Error} If the value does not match the schema
 */
module.exports.validate = (schema, value) => {
    const result = schema.safeParse(value);

    if (!result.success) {
        const firstIssue = result.error.issues[0];
        const path = firstIssue.path.length > 0 ? `${firstIssue.path.join(".")}: ` : "";
        throw new Error(`Invalid input. ${path}${firstIssue.message}`);
    }

    return result.data;
};
