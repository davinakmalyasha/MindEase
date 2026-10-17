// Proves the UI-hygiene ratchet fails in both directions.
//
// The maximum case is the obvious one. The floor case matters just as much: a
// walker that silently stops finding anything would report zero, sail under
// every maximum, and make the gate look green while the debt it exists to hold
// is unmeasured. Both are pinned here rather than trusted to review.

const { judge } = require("./check-ui-hygiene.js");

const budget = { hardcoded: 10, bypasses: 5, imagesMissingAlt: 0 };
const floor = { hardcoded: 8 };

const cases = [
    {
        name: "at every maximum passes",
        counts: { hardcoded: 10, bypasses: 5, imagesMissingAlt: 0 },
        expect: (r) => r.failures.length === 0,
    },
    {
        name: "one over a maximum fails, and names the count",
        counts: { hardcoded: 11, bypasses: 5, imagesMissingAlt: 0 },
        expect: (r) =>
            r.failures.length === 1 &&
            r.over.length === 1 &&
            /hardcoded UI strings: 11, budget 10 \(\+1\)/.test(r.over[0]),
    },
    {
        name: "a new <img> without alt fails at any count above zero",
        counts: { hardcoded: 10, bypasses: 5, imagesMissingAlt: 1 },
        expect: (r) => r.failures.length === 1 && r.over.length === 1,
    },
    {
        name: "paying debt down is allowed and does not fail",
        counts: { hardcoded: 9, bypasses: 4, imagesMissingAlt: 0 },
        expect: (r) => r.failures.length === 0,
    },
    {
        name: "a counter collapsing below its floor fails as a broken instrument",
        counts: { hardcoded: 0, bypasses: 5, imagesMissingAlt: 0 },
        expect: (r) =>
            r.failures.length === 1 &&
            r.under.length === 1 &&
            /did the walker break/.test(r.under[0]),
    },
    {
        name: "both directions can fail at once",
        counts: { hardcoded: 0, bypasses: 6, imagesMissingAlt: 0 },
        expect: (r) => r.failures.length === 2,
    },
];

let failed = 0;
for (const c of cases) {
    let ok = false;
    let detail = "";
    try {
        const result = judge(c.counts, budget, floor);
        ok = c.expect(result);
        detail = JSON.stringify({ over: result.over, under: result.under });
    } catch (e) {
        detail = e.message;
    }
    if (ok) console.log(`ok   ${c.name}`);
    else {
        failed += 1;
        console.error(`FAIL ${c.name} - got ${detail}`);
    }
}

if (failed) {
    console.error(`\n${failed} of ${cases.length} case(s) failed - the ratchet may be broken.`);
    process.exit(1);
}
console.log(`\ncheck-ui-hygiene self-test: ${cases.length} cases passed.`);
