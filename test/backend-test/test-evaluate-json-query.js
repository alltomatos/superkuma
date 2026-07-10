const { describe, test } = require("node:test");
const assert = require("node:assert");
const { evaluateJsonQuery } = require("../../src/util");

/**
 * Characterization baseline for evaluateJsonQuery() (src/util.js), the pure
 * "value -> pass/fail" evaluator shared today by server/monitor-types/prometheus.js
 * and server/monitor-types/snmp.js, pinned down BEFORE ADR-0015 (OTLP telemetry
 * receiver, docs/adr/0015-otlp-telemetry-receiver.md) reuses this exact function
 * for threshold evaluation of ingested metrics. Molded on the top-comment idiom
 * in test-uptime-calculator-anomaly-window.js -- no production code touched.
 *
 * Every assertion below was captured by actually running evaluateJsonQuery()
 * against the real jsonata (~2.1.0, see package.json) dependency and observing
 * its output; none of the expected values are hand-derived from reading the
 * source alone. Several results are genuinely surprising and are called out
 * inline where they are -- future readers touching this function (ADR-0015 or
 * otherwise) should not "fix" these without first re-reading the comment next
 * to the assertion that pins them down.
 */
describe("evaluateJsonQuery() - characterization (pre ADR-0015 OTLP receiver)", () => {
    describe("every jsonPathOperator - one passing and one failing case", () => {
        test("'>' passes when value > expected, fails when not", async () => {
            assert.deepStrictEqual(await evaluateJsonQuery("10", "$", ">", "5"), { status: true, response: 10 });
            assert.deepStrictEqual(await evaluateJsonQuery("3", "$", ">", "5"), { status: false, response: 3 });
        });

        test("'>=' passes on equality and on strictly-greater, fails when less", async () => {
            assert.deepStrictEqual(await evaluateJsonQuery("5", "$", ">=", "5"), { status: true, response: 5 });
            assert.deepStrictEqual(await evaluateJsonQuery("4", "$", ">=", "5"), { status: false, response: 4 });
        });

        test("'<' passes when value < expected, fails when not", async () => {
            assert.deepStrictEqual(await evaluateJsonQuery("3", "$", "<", "5"), { status: true, response: 3 });
            assert.deepStrictEqual(await evaluateJsonQuery("10", "$", "<", "5"), { status: false, response: 10 });
        });

        test("'<=' passes on equality and on strictly-less, fails when greater", async () => {
            assert.deepStrictEqual(await evaluateJsonQuery("5", "$", "<=", "5"), { status: true, response: 5 });
            assert.deepStrictEqual(await evaluateJsonQuery("6", "$", "<=", "5"), { status: false, response: 6 });
        });

        test("'!=' passes when different, fails when equal", async () => {
            assert.deepStrictEqual(await evaluateJsonQuery("5", "$", "!=", "6"), { status: true, response: 5 });
            assert.deepStrictEqual(await evaluateJsonQuery("5", "$", "!=", "5"), { status: false, response: 5 });
        });

        test("'==' passes when equal, fails when different", async () => {
            assert.deepStrictEqual(await evaluateJsonQuery("5", "$", "==", "5"), { status: true, response: 5 });
            assert.deepStrictEqual(await evaluateJsonQuery("5", "$", "==", "6"), { status: false, response: 5 });
        });

        test("'contains' passes on substring match, fails otherwise", async () => {
            assert.deepStrictEqual(await evaluateJsonQuery('"hello world"', "$", "contains", "world"), {
                status: true,
                response: "hello world",
            });
            assert.deepStrictEqual(await evaluateJsonQuery('"hello world"', "$", "contains", "xyz"), {
                status: false,
                response: "hello world",
            });
        });
    });

    describe("numeric string coercion", () => {
        test("'>','>=','<','<=' cast both sides via jsonata $number() -- scientific notation, negatives and decimals all coerce", async () => {
            assert.deepStrictEqual(await evaluateJsonQuery("1e2", "$", ">", "5"), { status: true, response: 100 });
            assert.deepStrictEqual(await evaluateJsonQuery("-10", "$", ">", "-20"), { status: true, response: -10 });
            assert.deepStrictEqual(await evaluateJsonQuery("1.5", "$", ">", "1.2"), { status: true, response: 1.5 });
        });

        test("'>' throws when $number() cannot cast the value -- non-numeric, whitespace-padded, and empty strings all fail to cast", async () => {
            await assert.rejects(evaluateJsonQuery('"abc"', "$", ">", "5"), {
                message:
                    'Error evaluating JSON query: Unable to cast value to a number: "abc". Response from server was: "abc"',
            });
            await assert.rejects(evaluateJsonQuery('" 10 "', "$", ">", "5"), {
                message:
                    'Error evaluating JSON query: Unable to cast value to a number: " 10 ". Response from server was: " 10 "',
            });
            await assert.rejects(evaluateJsonQuery('""', "$", ">", "5"), {
                message: 'Error evaluating JSON query: Unable to cast value to a number: "". Response from server was: ""',
            });
        });

        test("'==' and '!=' do NOT numerically coerce -- they compare value.toString() vs expected.toString() as plain strings, so \"5\" != \"5.0\"", async () => {
            // Contrast with '>=' on the exact same pair, which DOES coerce and considers them equal.
            assert.deepStrictEqual(await evaluateJsonQuery("5", "$", "==", "5.0"), { status: false, response: 5 });
            assert.deepStrictEqual(await evaluateJsonQuery("5", "$", "!=", "5.0"), { status: true, response: 5 });
            assert.deepStrictEqual(await evaluateJsonQuery("5", "$", ">=", "5.0"), { status: true, response: 5 });
        });
    });

    describe("jsonPath: '$' identity vs a real JSONata path", () => {
        test("'$' is a no-op identity path -- the parsed value passes through unchanged", async () => {
            assert.deepStrictEqual(await evaluateJsonQuery("42", "$", "==", "42"), { status: true, response: 42 });
        });

        test("a real JSONata path extracts a nested field before comparison", async () => {
            const data = JSON.stringify({ a: { b: 99 } });
            assert.deepStrictEqual(await evaluateJsonQuery(data, "a.b", ">", "50"), { status: true, response: 99 });
        });

        test("a falsy jsonPath ('') skips jsonata evaluation entirely and reuses the parsed response as-is -- same effective outcome as '$' for a whole-object response", async () => {
            const data = JSON.stringify({ a: 1 });
            // No jsonPath given -> the whole parsed object is the "response", which then hits the
            // object-rejection guard below (an object can never be compared to expectedValue directly).
            await assert.rejects(evaluateJsonQuery(data, "", "==", "x"), {
                message:
                    "Error evaluating JSON query: The post-JSON query evaluated response from the server is of type " +
                    'object, which cannot be directly compared to the expected value. Response from server was: {"a":1}',
            });
        });
    });

    describe("array response rejection (throws, with truncation to 25 chars once the stringified array exceeds 25 chars)", () => {
        test("an array whose JSON.stringify() is exactly 25 chars is shown in full, untruncated", async () => {
            const arr = ["a", "a", "a", "a", "a", "a"]; // JSON.stringify -> 25 chars exactly
            assert.strictEqual(JSON.stringify(arr).length, 25);
            await assert.rejects(evaluateJsonQuery(JSON.stringify(arr), "$", "==", "x"), {
                message:
                    'Error evaluating JSON query: JSON query returned the array ["a","a","a","a","a","a"], but a primitive ' +
                    "value is required. Modify your query to return a single value via [0] to get the first element or use " +
                    "an aggregation like $count(), $sum() or $boolean().. Response from server was: " +
                    '["a","a","a","a","a","a"]',
            });
        });

        test("an array whose JSON.stringify() exceeds 25 chars is truncated to the first 25 chars + '...]' in the array-rejection message itself", async () => {
            const arr = ["a", "a", "a", "a", "a", "a", "a"]; // JSON.stringify -> 29 chars, first 25 kept
            assert.strictEqual(JSON.stringify(arr).length, 29);
            await assert.rejects(evaluateJsonQuery(JSON.stringify(arr), "$", "==", "x"), {
                message:
                    'Error evaluating JSON query: JSON query returned the array ["a","a","a","a","a","a",...], but a ' +
                    "primitive value is required. Modify your query to return a single value via [0] to get the first " +
                    "element or use an aggregation like $count(), $sum() or $boolean().. Response from server was: " +
                    '["a","a","a","a","a","a","a"]',
            });
        });
    });

    describe("object/Date/function response rejection", () => {
        test("a plain object response throws the 'type object' guard error", async () => {
            const data = JSON.stringify({ a: 1 });
            await assert.rejects(evaluateJsonQuery(data, "$", "==", "x"), {
                message:
                    "Error evaluating JSON query: The post-JSON query evaluated response from the server is of type " +
                    'object, which cannot be directly compared to the expected value. Response from server was: {"a":1}',
            });
        });

        test("a real JS Date response also throws the 'type object' guard -- typeof a Date IS \"object\" in JS, so the explicit `response instanceof Date` check in the source is redundant/dead: the preceding `typeof response === \"object\"` arm of the || chain already always wins for real Date instances", async () => {
            // A raw (non-JSON) Date passed directly as `data`, with a falsy jsonPath so it survives
            // untouched: JSON.parse(date) fails (Date.toString() isn't valid JSON), so evaluateJsonQuery
            // falls back to `typeof data === "object" ? data : ...` and keeps the actual Date instance.
            const date = new Date("2026-01-01T00:00:00.000Z");
            await assert.rejects(evaluateJsonQuery(date, "", "==", "x"), {
                message:
                    "Error evaluating JSON query: The post-JSON query evaluated response from the server is of type " +
                    'object, which cannot be directly compared to the expected value. Response from server was: ' +
                    '"2026-01-01T00:00:00.000Z"',
            });
        });

        test("referencing a bare JSONata function (no invocation) also throws the 'type object' guard -- jsonata (~2.1.0) never returns a real JS `typeof === \"function\"` value from evaluate(); built-ins/lambdas are represented as plain marker objects (_jsonata_function/_jsonata_lambda), so the `typeof response === \"function\"` arm of the guard is unreachable through this code path with the current jsonata version", async () => {
            const data = JSON.stringify([1, 2, 3]);
            await assert.rejects(evaluateJsonQuery(data, "$sum", "==", "x"), {
                message:
                    "Error evaluating JSON query: The post-JSON query evaluated response from the server is of type " +
                    "object, which cannot be directly compared to the expected value. Response from server was: " +
                    '{"_jsonata_function":true,"signature":{"definition":"<a<n>:n>"}}… (truncated)',
            });
        });
    });

    describe("null/undefined response after path evaluation", () => {
        test("a jsonPath resolving to an explicit null throws 'Empty or undefined response'", async () => {
            const data = JSON.stringify({ a: null });
            await assert.rejects(evaluateJsonQuery(data, "a", "==", "x"), {
                message:
                    "Error evaluating JSON query: Empty or undefined response. Check query syntax and response " +
                    "structure. Response from server was: null",
            });
        });

        test("a jsonPath resolving to a missing field (undefined) throws the same guard, with 'undefined' interpolated as the response text", async () => {
            const data = JSON.stringify({ a: 1 });
            await assert.rejects(evaluateJsonQuery(data, "b", "==", "x"), {
                message:
                    "Error evaluating JSON query: Empty or undefined response. Check query syntax and response " +
                    "structure. Response from server was: undefined",
            });
        });
    });

    describe("invalid jsonPathOperator", () => {
        test("an operator outside the switch's cases throws 'Invalid condition <op>'", async () => {
            await assert.rejects(evaluateJsonQuery("5", "$", "~=", "5"), {
                message: "Error evaluating JSON query: Invalid condition ~=. Response from server was: 5",
            });
        });
    });

    describe("non-JSON-parseable input falls back to a raw string/number", () => {
        test("a non-JSON string is used as-is (JSON.parse fails, data is already a string -> data.toString() is a no-op)", async () => {
            assert.deepStrictEqual(await evaluateJsonQuery("hello not json", "$", "contains", "not"), {
                status: true,
                response: "hello not json",
            });
        });

        test("a raw JS number that JSON.parse rejects (NaN) is kept as the actual number, not stringified -- typeof data === \"number\" takes the `data` (not `data.toString()`) branch of the fallback", async () => {
            // JSON.parse(NaN) fails because String(NaN) === "NaN", not valid JSON. Falls back to the raw
            // NaN value itself (typeof "number" bypasses .toString()). value.toString() is then "NaN",
            // and "NaN" != "x" as plain strings, so '!=' passes without ever needing $number() to succeed.
            const result = await evaluateJsonQuery(NaN, "$", "!=", "x");
            assert.strictEqual(result.status, true);
            assert.ok(Number.isNaN(result.response), "response is the real NaN value, not a string");
        });
    });

    describe("catch-all error wrapping ('Error evaluating JSON query: <cause>. Response from server was: <response>') and its own, separate truncation of the echoed response", () => {
        test("a response whose JSON.stringify() is exactly 50 chars is echoed in full -- the > 50 threshold is not inclusive", async () => {
            const data = JSON.stringify({ a: "x".repeat(42) }); // JSON.stringify -> 50 chars exactly
            assert.strictEqual(JSON.stringify({ a: "x".repeat(42) }).length, 50);
            await assert.rejects(evaluateJsonQuery(data, "$", "==", "x"), {
                message:
                    "Error evaluating JSON query: The post-JSON query evaluated response from the server is of type " +
                    "object, which cannot be directly compared to the expected value. Response from server was: " +
                    `{"a":"${"x".repeat(42)}"}`,
            });
        });

        test("a response whose JSON.stringify() is 51 chars gets the '… (truncated)' suffix appended even though substring(0,100) does not actually cut anything -- the suffix is misleading below 100 chars", async () => {
            const data = JSON.stringify({ a: "x".repeat(43) }); // JSON.stringify -> 51 chars
            assert.strictEqual(JSON.stringify({ a: "x".repeat(43) }).length, 51);
            await assert.rejects(evaluateJsonQuery(data, "$", "==", "x"), {
                message:
                    "Error evaluating JSON query: The post-JSON query evaluated response from the server is of type " +
                    "object, which cannot be directly compared to the expected value. Response from server was: " +
                    `{"a":"${"x".repeat(43)}"}… (truncated)`,
            });
        });

        test("a response longer than 100 chars is actually cut down to the first 100 chars before the '… (truncated)' suffix -- NOT 50, despite the truncation kicking in at the length > 50 threshold", async () => {
            const longObj = {};
            for (let i = 0; i < 20; i++) {
                longObj["field" + i] = "value_padding_padding_" + i;
            }
            const fullJson = JSON.stringify(longObj);
            assert.ok(fullJson.length > 100, "fixture must exceed the 100-char cut length to be a meaningful test");

            await assert.rejects(evaluateJsonQuery(JSON.stringify(longObj), "$", "==", "x"), {
                message:
                    "Error evaluating JSON query: The post-JSON query evaluated response from the server is of type " +
                    "object, which cannot be directly compared to the expected value. Response from server was: " +
                    `${fullJson.substring(0, 100)}… (truncated)`,
            });
        });
    });
});
