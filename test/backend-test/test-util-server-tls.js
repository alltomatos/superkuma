const { describe, test } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));

process.env.TEST_BACKEND = "1";

const {
    getDaysRemaining,
    checkCertificate,
    rootCertificatesFingerprints,
    percentageToColor,
    filterAndJoin,
    timeObjectToUTC,
    timeObjectToLocal,
    shake256,
    encodeBase64,
    convertToUTF8,
} = require("../../server/util-server");

describe("tls.js: getDaysRemaining()", () => {
    test("returns a positive number of days when certificate is still valid", () => {
        const validFrom = new Date();
        const validTo = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // +10 days
        assert.strictEqual(getDaysRemaining(validFrom, validTo), 10);
    });

    test("returns a negative number of days when certificate already expired", () => {
        const validFrom = new Date("2020-01-01T00:00:00Z");
        const validTo = new Date("2020-01-11T00:00:00Z"); // 10 days after validFrom, but long expired
        const daysRemaining = getDaysRemaining(validFrom, validTo);
        assert.strictEqual(daysRemaining, -10);
        assert.ok(daysRemaining < 0, "Expired certificates must report negative days remaining");
    });

    test("returns 0 when validFrom and validTo are the same instant in the future", () => {
        const now = new Date(Date.now() + 60 * 1000);
        assert.strictEqual(getDaysRemaining(now, now), 0);
    });

    test("magnitude of days is based on the absolute difference between the two dates", () => {
        const validFrom = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
        const validTo = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000);
        assert.strictEqual(getDaysRemaining(validFrom, validTo), 30);
    });
});

describe("tls.js: checkCertificate()", () => {
    test("returns null when socket is null", () => {
        assert.strictEqual(checkCertificate(null), null);
    });

    test("returns null when socket is undefined", () => {
        assert.strictEqual(checkCertificate(undefined), null);
    });

    test("parses a self-signed certificate from a fake socket", () => {
        const fakeSocket = {
            authorized: true,
            getPeerCertificate: () => ({
                fingerprint: "AA:BB",
                valid_from: "Jan 1 00:00:00 2020 GMT",
                valid_to: "Jan 1 00:00:00 2035 GMT",
                subjectaltname: "DNS:example.com, DNS:www.example.com",
                issuerCertificate: null,
            }),
        };

        const result = checkCertificate(fakeSocket);

        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.certInfo.certType, "self-signed");
        assert.deepStrictEqual(result.certInfo.validFor, ["example.com", "www.example.com"]);
        assert.ok(result.certInfo.validTo instanceof Date);
    });

    test("marks socket as invalid when socket.authorized is false", () => {
        const fakeSocket = {
            authorized: false,
            getPeerCertificate: () => ({
                fingerprint: "CC:DD",
                valid_from: "Jan 1 00:00:00 2020 GMT",
                valid_to: "Jan 1 00:00:00 2035 GMT",
                issuerCertificate: null,
            }),
        };

        const result = checkCertificate(fakeSocket);
        assert.strictEqual(result.valid, false);
    });

    test("walks the issuer chain and marks intermediate/root cert types", () => {
        const rootCert = {
            fingerprint: "ROOT",
            valid_from: "Jan 1 00:00:00 2010 GMT",
            valid_to: "Jan 1 00:00:00 2040 GMT",
            issuerCertificate: null,
        };
        const intermediateCert = {
            fingerprint: "INTERMEDIATE",
            valid_from: "Jan 1 00:00:00 2015 GMT",
            valid_to: "Jan 1 00:00:00 2035 GMT",
            issuerCertificate: rootCert,
        };
        const leafCert = {
            fingerprint: "LEAF",
            valid_from: "Jan 1 00:00:00 2020 GMT",
            valid_to: "Jan 1 00:00:00 2030 GMT",
            subjectaltname: "DNS:example.com",
            issuerCertificate: intermediateCert,
        };
        const fakeSocket = {
            authorized: true,
            getPeerCertificate: () => leafCert,
        };

        const result = checkCertificate(fakeSocket);

        assert.strictEqual(result.certInfo.certType, "server");
        assert.strictEqual(result.certInfo.issuerCertificate.certType, "intermediate CA");
        assert.strictEqual(result.certInfo.issuerCertificate.issuerCertificate.certType, "root CA");
    });
});

describe("tls.js: rootCertificatesFingerprints()", () => {
    test("returns a Set of colon-separated uppercase hex fingerprints", () => {
        const fingerprints = rootCertificatesFingerprints();
        assert.ok(fingerprints instanceof Set);
        assert.ok(fingerprints.size > 0);

        for (const fp of fingerprints) {
            assert.match(fp, /^[0-9A-F]{2}(:[0-9A-F]{2})*$/);
        }
    });

    test("includes the manually appended ISRG cross-sign fingerprints", () => {
        const fingerprints = rootCertificatesFingerprints();
        assert.ok(
            fingerprints.has(
                "6D:99:FB:26:5E:B1:C5:B3:74:47:65:FC:BC:64:8F:3C:D8:E1:BF:FA:FD:C4:C2:F9:9B:9D:47:CF:7F:F1:C2:4F"
            ),
            "Missing ISRG X1 cross-signed with DST X3 fingerprint"
        );
        assert.ok(
            fingerprints.has(
                "8B:05:B6:8C:C6:59:E5:ED:0F:CB:38:F2:C9:42:FB:FD:20:0E:6F:2F:F9:F8:5D:63:C6:99:4E:F5:E0:B0:27:01"
            ),
            "Missing ISRG X2 cross-signed with ISRG X1 fingerprint"
        );
    });

    test("has one fingerprint per built-in root certificate plus the two manual entries", () => {
        const tls = require("tls");
        const fingerprints = rootCertificatesFingerprints();
        assert.strictEqual(fingerprints.size, tls.rootCertificates.length + 2);
    });
});

describe("format.js: percentageToColor()", () => {
    test("returns a red-ish hue for 0%", () => {
        assert.strictEqual(percentageToColor(0), "#c2290a");
    });

    test("returns a green-ish hue for 100%", () => {
        assert.strictEqual(percentageToColor(1), "#66c20a");
    });

    test("returns a mid-tone hue for 50%", () => {
        assert.strictEqual(percentageToColor(0.5), "#c2a30a");
    });

    test("falls back to the badge N/A color on invalid chroma input", () => {
        const { badgeConstants } = require("../../src/util");
        // NaN percentage produces an invalid hsl() string for chroma-js
        assert.strictEqual(percentageToColor(NaN), badgeConstants.naColor);
    });
});

describe("format.js: filterAndJoin()", () => {
    test("filters out empty/null/undefined entries and joins the rest", () => {
        assert.strictEqual(filterAndJoin(["a", "", null, "b", undefined, "c"], "-"), "a-b-c");
    });

    test("uses empty string connector by default", () => {
        assert.strictEqual(filterAndJoin(["foo", "bar"]), "foobar");
    });

    test("returns empty string when all parts are falsy", () => {
        assert.strictEqual(filterAndJoin([ "", null, undefined ], ","), "");
    });
});

describe("format.js: timeObjectToUTC() / timeObjectToLocal()", () => {
    test("timeObjectToUTC shifts a negative-offset timezone forward", () => {
        // America/Sao_Paulo is UTC-3
        const result = timeObjectToUTC({ hours: 10, minutes: 30 }, "America/Sao_Paulo");
        assert.deepStrictEqual(result, { hours: 13, minutes: 30 });
    });

    test("timeObjectToLocal shifts a negative-offset timezone backward", () => {
        const result = timeObjectToLocal({ hours: 10, minutes: 30 }, "America/Sao_Paulo");
        assert.deepStrictEqual(result, { hours: 7, minutes: 30 });
    });

    test("timeObjectToUTC/timeObjectToLocal are inverses of each other", () => {
        const original = { hours: 14, minutes: 45 };
        const toUTC = timeObjectToUTC({ ...original }, "Asia/Kolkata");
        const backToLocal = timeObjectToLocal({ ...toUTC }, "Asia/Kolkata");
        assert.deepStrictEqual(backToLocal, original);
    });

    test("handles hour underflow/overflow bounds", () => {
        // 23:45 UTC->local in a positive offset zone should wrap to the next/previous day's hour range
        const result = timeObjectToLocal({ hours: 23, minutes: 0 }, "Asia/Kolkata");
        assert.ok(result.hours >= 0 && result.hours < 24);
    });
});

describe("format.js: shake256()", () => {
    test("returns empty string for falsy input", () => {
        assert.strictEqual(shake256("", 16), "");
        assert.strictEqual(shake256(null, 16), "");
        assert.strictEqual(shake256(undefined, 16), "");
    });

    test("produces a deterministic hex digest of the requested byte length", () => {
        const digest = shake256("hello", 16);
        assert.strictEqual(digest, "1234075ae4a1e77316cf2d8000974581");
        assert.strictEqual(digest.length, 32); // 16 bytes => 32 hex chars
        assert.match(digest, /^[0-9a-f]+$/);
    });

    test("different output lengths produce correspondingly different digest string sizes", () => {
        // SHAKE256 is an extendable-output function (XOF): the shorter digest is a
        // prefix of the longer one, so we assert on sizes rather than divergent content.
        const short = shake256("hello world", 8);
        const long = shake256("hello world", 32);
        assert.strictEqual(short.length, 16);
        assert.strictEqual(long.length, 64);
        assert.strictEqual(long.startsWith(short), true);
    });

    test("is deterministic for the same input and length", () => {
        assert.strictEqual(shake256("repeat-me", 16), shake256("repeat-me", 16));
    });
});

describe("format.js: encodeBase64()", () => {
    test("encodes user:pass as base64", () => {
        assert.strictEqual(encodeBase64("user", "pass"), Buffer.from("user:pass").toString("base64"));
    });

    test("treats null/undefined user or pass as empty string", () => {
        assert.strictEqual(encodeBase64(null, null), Buffer.from(":").toString("base64"));
        assert.strictEqual(encodeBase64(undefined, "pass"), Buffer.from(":pass").toString("base64"));
        assert.strictEqual(encodeBase64("user", undefined), Buffer.from("user:").toString("base64"));
    });
});

describe("format.js: convertToUTF8()", () => {
    test("returns a plain UTF8 string unchanged in content", () => {
        const buf = Buffer.from("hello world", "utf8");
        assert.strictEqual(convertToUTF8(buf), "hello world");
    });

    test("decodes a UTF-8 buffer with multi-byte characters", () => {
        const buf = Buffer.from("héllo wörld ñ", "utf8");
        assert.strictEqual(convertToUTF8(buf), "héllo wörld ñ");
    });
});
