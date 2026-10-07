// Guards the two races this pass fixed, because both are invisible in review.
//
// A stale-response bug has no type signature, no failing test, and no visual
// symptom until a user happens to be slow. The only reliable defence is a gate
// that fails when the mechanism is absent.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
let fail = 0;
const ok = (n) => {
    console.log(`ok   ${n}`);
    pass += 1;
};
const bad = (n, why) => {
    console.log(`FAIL ${n}\n       ${why}`);
    fail += 1;
};

console.log("--- a page keyed by a route param rejects stale responses ---");
// Next.js keeps the same component mounted across /[appointmentId]/A ->
// /[appointmentId]/B, and `params` resolves asynchronously, so a component that
// fetches per-param can have two requests in flight and write them out of order.
const PARAM_PAGES = [
    "client/app/dashboard/briefing/[appointmentId]/page.tsx",
    "client/app/dashboard/pre-session/[appointmentId]/page.tsx",
];

for (const f of PARAM_PAGES) {
    const src = read(f);
    const hasGuard =
        /requestSeq/.test(src) || /isCurrent/.test(src) || /let current = true/.test(src);
    if (hasGuard) ok(`${f} guards against a stale response`);
    else bad(`${f} guards against a stale response`, "no sequence or liveness flag");
}

console.log("\n--- the guard is applied after the awaits, not before ---");
// A check placed at the top of the function is worthless: the request it guards
// has not resolved yet.
const BRIEFING = PARAM_PAGES[0];
{
    const src = read(BRIEFING);
    // Every `.then` and `catch` on a fetch must re-check.
    // Only handlers on a *fetch* chain count. `.then()` on other promises, and the
// promise returned by `params.then(...)`, have nothing to do with the sequence
// and would otherwise be counted as unguarded.
const chains = [...src.matchAll(/api\.(get|post)\([^;]*?\)\s*\n\s*\.(then|catch)\(/g)];
    let unguarded = [];
    for (const h of chains) {
        const body = src.slice(h.index, h.index + 500);
        if (!/requestSeq\.current/.test(body)) unguarded.push(body.slice(0, 60).replace(/\n/g, " "));
    }
    if (chains.length === 0) bad("every fetch handler re-checks", "no fetch chains found");
    else if (unguarded.length === 0) ok(`all ${chains.length} fetch chains re-check the sequence`);
    else bad("every fetch handler re-checks", `${unguarded.length}/${chains.length} unguarded: ${unguarded[0]}`);
}

console.log("\n--- unmount invalidates in-flight work ---");
// Without this, a response that settles after unmount still runs its setState.
{
    const src = read(BRIEFING);
    if (/return\s*\(\)\s*=>\s*\{\s*requestSeq\.current\s*\+=/.test(src))
        ok("unmount bumps the sequence so pending writes are refused");
    else bad("unmount bumps the sequence so pending writes are refused", "no cleanup");
}

console.log("\n--- a pagination cursor does not advance on a failed page ---");
// The defect: `await loadPage(n + 1); setPage(p => p + 1)` unconditionally. One
// failure makes a page of results unreachable for the rest of the session.
{
    const src = read("client/app/doctors/page.tsx");
    if (!/if \(await loadPage\(next\)\) setPage\(next\)/.test(src))
        bad("the page cursor advances only on success", "loadPage result is discarded");
    else ok("the page cursor advances only on success");

    // The declared return type is what matters here, not an inferred one: the
// whole point is that the *caller* cannot silently ignore the result.
if (/const loadPage = async \([^)]*\)\s*:\s*Promise<boolean>/.test(src))
        ok("loadPage declares that it reports success");
    else if (/const loadPage = async \([^)]*\)\s*\{/.test(src))
        bad("loadPage declares that it reports success", "no return type, so the contract is invisible");
    else bad("loadPage declares that it reports success", "loadPage not found");

    if (/return true;/.test(src) && /return false;/.test(src))
        ok("loadPage returns both outcomes");
    else bad("loadPage returns both outcomes", "one of the success and failure paths has no return");
}

console.log("\n--- a failed AI match is not reported as zero matches ---");
// `setAiMatches([])` on failure renders "No specialists matched your
// description" - a claim about the roster, manufactured by a network error.
{
    const src = read("client/app/doctors/page.tsx");
    // Anchored on the call, so this inspects the catch belonging to
    // `ai/match-doctors` rather than whichever catch happens to come first.
    const idx = src.indexOf('"/ai/match-doctors"');
    if (idx === -1) {
        bad("a failed AI match stays distinct", "the match call was not found");
    } else {
        const after = src.slice(idx, idx + 900);
        const start = after.indexOf("catch");
        const stop = after.indexOf("finally");
        const catchBlock = start !== -1 && stop > start ? after.slice(start, stop) : "";
        if (!catchBlock) bad("a failed AI match stays distinct", "no catch after the match call");
        else if (/setAiMatches\(\[\]\)/.test(catchBlock))
            bad("a failed AI match stays distinct", "the catch still sets an empty result");
        else if (/setAiFailed\(true\)/.test(catchBlock) && /setAiMatches\(null\)/.test(catchBlock))
            ok("a failed AI match stays distinct");
        else bad("a failed AI match stays distinct", "the catch does not record a failure and clear the list");
    }
}

console.log(`\ncheck-stale-writes: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);