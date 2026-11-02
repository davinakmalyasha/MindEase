// Self-test for scripts/check-encoding.js.
//
// This gate has caught three real mojibake incidents, but nothing proves the
// detector itself still works: a broken regex would report "no corrupted
// characters found" on a tree full of them and CI would stay green. These
// cases pin each detector against the corruption it exists to find, plus a
// clean line each must accept.
//
// NOTE: fixtures use \u escapes, never literal corruption. The gate scans raw
// source bytes, so a literal U+FFFD or mojibake pair in this file would fail
// the very check this test exists to pin (a scanner that reads its own
// fixtures as evidence of the bug is worse than no scanner).
const assert = require("assert");
const { REPLACEMENT, LOST_GLYPH, CP1252 } = require("./check-encoding.js");

const cases = [
    {
        name: "lossy U+FFFD is caught",
        re: REPLACEMENT,
        bad: "price \uFFFDilter",
        good: "price filter",
    },
    {
        name: "lost glyph (typographic punct + ?) is caught",
        re: LOST_GLYPH,
        bad: "most people wait\u2014?",
        good: "most people wait \u2014 years",
    },
    {
        name: "reversible cp1252 mojibake is caught",
        re: CP1252,
        bad: "caf\u00C3\u00A9",
        good: "caf\u00E9",
    },
];

let failed = 0;
for (const c of cases) {
    try {
        assert.ok(c.re.test(c.bad), `should flag ${JSON.stringify(c.bad)}`);
        assert.ok(!c.re.test(c.good), `should accept ${JSON.stringify(c.good)}`);
        console.log(`ok   ${c.name}`);
    } catch (e) {
        failed++;
        console.error(`FAIL ${c.name}: ${e.message}`);
    }
}
if (failed > 0) {
    console.error(`check-encoding self-test: ${failed} case(s) failed`);
    process.exit(1);
}
console.log("check-encoding self-test: 3 cases passed.");
