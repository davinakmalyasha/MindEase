// Self-test for scripts/check-numbers.js.
//
// This gate is the only thing keeping fourteen documented counts honest, but
// nothing proves the checker itself can fail: a comparison that always passes
// would report agreement on a tree full of drift. These cases pin the pure
// core (judgeClaim) in both directions — agreement passes, a wrong figure
// fails, and a restructured document errors (the exit-2 path) instead of
// silently passing.
const assert = require("assert");
const { judgeClaim } = require("./check-numbers.js");

const anchor = /\*\*(\d+)\*\* \| API routes .*\*\*(\d+)\*\* tables .*\*\*(\d+)\*\* migrations/;
const doc = "README.md";

let failed = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`ok   ${name}`);
    } catch (e) {
        failed++;
        console.error(`FAIL ${name}: ${e.message}`);
    }
}

check("agreement passes", () => {
    const r = judgeClaim(doc, "**162** | API routes · **28** tables · **20** migrations", anchor, [162, 28, 20]);
    assert.deepStrictEqual(r, {});
});

check("a wrong figure fails", () => {
    const r = judgeClaim(doc, "**161** | API routes · **28** tables · **20** migrations", anchor, [162, 28, 20]);
    assert.ok(r.failure && r.failure.includes("figure 1 says 161"), JSON.stringify(r));
});

check("a wrong second figure fails", () => {
    const r = judgeClaim(doc, "**162** | API routes · **27** tables · **20** migrations", anchor, [162, 28, 20]);
    assert.ok(r.failure && r.failure.includes("figure 2 says 27"), JSON.stringify(r));
});

check("a restructured document errors instead of passing", () => {
    const r = judgeClaim(doc, "API routes: lots, tables: many", anchor, [162, 28, 20]);
    assert.ok(r.error && r.error.includes("no longer matches"), JSON.stringify(r));
});

if (failed > 0) {
    console.error(`check-numbers self-test: ${failed} case(s) failed`);
    process.exit(1);
}
console.log("check-numbers self-test: 4 cases passed.");
