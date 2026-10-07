// Guards the specific defect this pass fixed, so it cannot come back.
//
// The bug class: a fetch fails, the failure is swallowed or converted to a
// falsy value, and the JSX renders an "empty" state that is really an
// "unknown" state. The two look identical and one of them is a lie.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
let fail = 0;

function ok(name) {
    console.log(`ok   ${name}`);
    pass += 1;
}
function bad(name, why) {
    console.log(`FAIL ${name}\n       ${why}`);
    fail += 1;
}

const PANELS = [
    { file: "client/app/dashboard/page.tsx", states: ["statsFailed", "loadingStats", "ErrorState", "LoadingState"] },
    { file: "client/app/dashboard/briefing/[appointmentId]/page.tsx", states: ["loadFailed", "reload"] },
    { file: "client/app/dashboard/pre-session/[appointmentId]/page.tsx", states: ["loadFailed"] },
    { file: "client/app/dashboard/profile/page.tsx", states: ["profileFailed"] },
    { file: "client/app/doctors/[id]/page.tsx", states: ["loadFailed"] },
    { file: "client/components/doctors/DoctorProfile.tsx", states: ["packagesFailed", "loadPackages"] },
];

console.log("--- every data panel distinguishes failure from emptiness ---");
for (const p of PANELS) {
    const src = read(p.file);
    const missing = p.states.filter((s) => !src.includes(s));
    if (missing.length === 0) ok(`${p.file} has distinct failure state`);
    else bad(`${p.file} has distinct failure state`, `missing: ${missing.join(", ")}`);
}

console.log("\n--- no panel swallows an error into a falsy value ---");
// The anti-pattern: `.catch(() => {})` or `.catch(() => null)` on a fetch whose
// result decides whether the user is told they have no data.
const SWALLOWS = /\.catch\(\(\)\s*=>\s*\{\s*\}\)|\.catch\(\(\)\s*=>\s*null\)/;
const CLIENT = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".next", "test-results", "playwright-report"].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".tsx") || e.name.endsWith(".ts")) CLIENT.push(p);
    }
})(path.join(ROOT, "client"));

// Known-safe: optimistic rollback deliberately re-fetches, and the api
// interceptor's fallback is not a rendered state.
const ALLOWED = new Set([
    "client/hooks/useNotifications.ts", // rolls back an optimistic update by refetching
    "client/lib/api.ts", // interceptor, not rendered
    "client/e2e/journeys.spec.ts", // test code
]);

// Comments are stripped before matching. Several of these files now *mention*
// the anti-pattern in prose explaining why it was removed, and a scanner that
// reads its own documentation as evidence of the bug is worse than no scanner.
function code(file) {
    return fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

let swallowCount = 0;
for (const abs of CLIENT) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    if (ALLOWED.has(rel)) continue;
    if (SWALLOWS.test(code(abs))) {
        bad(`${rel} does not swallow a fetch error`, "matches .catch(() => {}) or .catch(() => null)");
        swallowCount += 1;
    }
}
if (swallowCount === 0) ok("no swallowed fetch errors in rendered components");

console.log("\n--- an editing form is not rendered before it has loaded ---");
// If a form's fields default to "", rendering it after a failed load means
// saving sends "" for every field the user did not touch.
const FORMS = [
    { file: "client/app/dashboard/profile/page.tsx", guard: "profileFailed", submit: "handleSubmit" },
];
for (const f of FORMS) {
    const src = read(f.file);
    // The guard must appear before the form element in source order.
    const guardAt = src.indexOf(f.guard + ") {");
    const formAt = src.indexOf("<form");
    if (guardAt === -1) bad(`${f.file} blocks the form on load failure`, `no "${f.guard}) {" guard`);
    else if (formAt !== -1 && guardAt > formAt)
        bad(`${f.file} blocks the form on load failure`, "the form is rendered before the failure guard");
    else ok(`${f.file} blocks the form on load failure`);
}

console.log("\n--- an absent record is only reported absent on a 404 ---");
// A network error is not evidence of absence. Treating it as such regenerates
// records that already exist.
const PROBES = [
    "client/app/dashboard/briefing/[appointmentId]/page.tsx",
    "client/app/dashboard/pre-session/[appointmentId]/page.tsx",
];
for (const p of PROBES) {
    const src = read(p);
    if (src.includes("404")) ok(`${p} distinguishes 404 from other failures`);
    else bad(`${p} distinguishes 404 from other failures`, "no 404 check");
}

console.log(`\ncheck-load-states: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);