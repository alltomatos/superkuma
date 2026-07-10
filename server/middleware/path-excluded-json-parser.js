const express = require("express");

/**
 * Build an Express JSON body-parser middleware that behaves exactly like
 * `express.json()` for every path EXCEPT the given exclusion list, where it
 * is a no-op (`next()` immediately, body left unparsed for a route-specific
 * parser further down the stack to handle instead).
 *
 * Extracted out of server.js (ADR-0015 TASK-A2-4) so this exact mechanism is
 * unit-testable in isolation: body-parser middleware only ever reads/parses
 * a request body once per request, so an app-wide `express.json()` (default
 * ~100kb limit) running BEFORE a route's own larger-limit parser would
 * already have parsed/rejected the body -- with the WRONG limit -- before
 * the route-specific parser ever got a chance to apply its own. Excluding
 * that one path from the app-wide parser is what makes the route's own
 * limit the one actually enforced.
 * @param {string[]} excludedPaths Exact `request.path` values this parser
 *     must skip (leaving the body unparsed for a later middleware).
 * @returns {import("express").RequestHandler} The middleware function.
 */
function pathExcludedJsonParser(excludedPaths) {
    const parser = express.json();
    const excluded = new Set(excludedPaths);

    return function (request, response, next) {
        if (excluded.has(request.path)) {
            next();
            return;
        }
        parser(request, response, next);
    };
}

module.exports = { pathExcludedJsonParser };
