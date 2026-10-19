#!/usr/bin/env node
/**
 * Documented counts checked against the tree.
 *
 * Every number quoted in README.md and docs/testing.md is re-derived here and
 * the build fails on a disagreement. A count that quietly stops being checked
 * is worse than a wrong one, so an anchor that no longer matches the document
 * exits 2 (configuration error) rather than passing silently.
 *
 * The measurement targets moved with the port: tables come from the runtime's
 * own expected-table list, migrations from server-go/migrations, and the Go
 * test/lines counts cover both modules.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const lineCount = (rel) => read(rel).split(/\r?\n/).length;

function walk(rel) {
    const out = [];
    const visit = (p) => {
        for (const entry of fs.readdirSync(path.join(ROOT, p), { withFileTypes: true })) {
            const child = path.join(p, entry.name).replaceAll("\\", "/");
            if (entry.isDirectory()) {
                if (["node_modules", ".git", ".next"].includes(entry.name)) continue;
                visit(child);
            } else {
                out.push(child);
            }
        }
    };
    visit(rel);
    return out;
}

const M = {};

/** Tables the runtime's /api/health/db check insists exist. */
M.models = () => {
    const src = read("server-go/internal/server/server.go");
    const block = src.split("var expectedTables = []string{")[1].split("}")[0];
    return (block.match(/"[A-Za-z]+"/g) || []).length;
};

M.migrations = () =>
    fs.readdirSync(path.join(ROOT, "server-go/migrations")).filter((f) => f.endsWith(".up.sql")).length;

M.migrationSqlLines = () =>
    fs
        .readdirSync(path.join(ROOT, "server-go/migrations"))
        .filter((f) => f.endsWith(".up.sql"))
        .reduce((n, f) => n + lineCount(`server-go/migrations/${f}`), 0);

/** Route registrations in the domain files plus the four core endpoints. */
M.routes = () => {
    const dir = "server-go/internal/server";
    const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => /^routes_.*\.go$/.test(f));
    let n = 0;
    for (const f of files) {
        n += (read(`${dir}/${f}`).match(/\.(Get|Post|Put|Patch|Delete)\("/g) || []).length;
    }
    return n + 4; // health, health/db, csrf-token, openapi.json
};

function goModules() {
    return ["server-go", "server-realtime"];
}

function goSuite(mod) {
    const files = walk(mod).filter((f) => f.endsWith("_test.go"));
    // `TestMain(m *testing.M)` is harness setup, not a test; matching the
    // testing.T parameter excludes it without hard-coding the name.
    return {
        files: files.length,
        tests: files.reduce((n, f) => n + (read(f).match(/^func Test[A-Za-z0-9_]*\(t \*testing\.T/gm) || []).length, 0),
    };
}

M.apiGoTests = () => goSuite("server-go").tests;
M.apiGoTestFiles = () => goSuite("server-go").files;
M.rtGoTests = () => goSuite("server-realtime").tests;
M.rtGoTestFiles = () => goSuite("server-realtime").files;
M.goTests = () => M.apiGoTests() + M.rtGoTests();
M.goTestFiles = () => M.apiGoTestFiles() + M.rtGoTestFiles();

M.goLines = () =>
    goModules()
        .flatMap((m) => walk(m))
        .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
        .reduce((n, f) => n + lineCount(f), 0);

/** `it(` / `test(` occurrences, minus the skipped ones. */
function countCases(src) {
    const all = (src.match(/^\s*(?:it|test)\s*\(/gm) || []).length;
    const skipped = (src.match(/^\s*(?:it|test)\.(?:skip|todo|each)\s*\(/gm) || []).length;
    const each = (src.match(/^\s*(?:it|test)\.each\b/gm) || []).length;
    return all - skipped + each;
}

function suite(rel, dir) {
    const files = walk(`${rel}/${dir}`).filter((f) => /\.test\.tsx?$/.test(f));
    return { files: files.length, tests: files.reduce((n, f) => n + countCases(read(f)), 0) };
}

M.clientTests = () => suite("client", "tests").tests;
M.clientTestFiles = () => suite("client", "tests").files;

M.playwrightTests = () =>
    walk("client/e2e")
        .filter((f) => f.endsWith(".spec.ts"))
        .reduce((n, f) => n + (read(f).match(/^\s*test\s*\(/gm) || []).length, 0);

M.playwrightJourneys = () =>
    walk("client/e2e")
        .filter((f) => f.endsWith(".spec.ts"))
        .reduce((n, f) => n + (read(f).match(/test\.describe\s*\(/g) || []).length, 0);

function tsBreakdown() {
    const isSource = (f) => /\.tsx?$/.test(f);
    let app = 0;
    let tests = 0;
    for (const root of ["client/app", "client/components", "client/lib", "client/hooks", "client/context", "client/i18n"]) {
        for (const f of walk(root)) if (isSource(f)) app += lineCount(f);
    }
    for (const f of walk("client/tests")) if (isSource(f)) tests += lineCount(f);
    return { app, tests };
}

M.appLines = () => tsBreakdown().app;
M.testLines = () => tsBreakdown().tests;

M.adrCount = () =>
    fs.readdirSync(path.join(ROOT, "docs/adr")).filter((f) => /^\d{4}-.+\.md$/.test(f) && f !== "0000-template.md").length;

function pkgVersion(rel, dep) {
    const p = JSON.parse(read(rel));
    return (p.dependencies && p.dependencies[dep]) || (p.devDependencies && p.devDependencies[dep]) || "";
}

const bare = (v) => String(v).replace(/^[\^~>=<\s]*/, "").split(".").slice(0, 2).join(".");

M.nextVersion = () => bare(pkgVersion("client/package.json", "next"));
M.goVersion = () => (read("server-realtime/go.mod").match(/^go\s+(\S+)/m) || [, ""])[1];
M.vitestClient = () => bare(pkgVersion("client/package.json", "vitest"));

// --- claims ------------------------------------------------------------------

const CLAIMS = [
    { doc: "README.md", anchor: /\*\*(\d+)\*\* \| API routes .*\*\*(\d+)\*\* tables .*\*\*(\d+)\*\* migrations/,
        measure: M.routes, second: M.models, third: M.migrations },
    { doc: "README.md", anchor: /\*\*(\d+)\*\* \| Go tests in (\d+) files .*\*\*(\d+)\*\* client unit tests/,
        measure: M.goTests, second: M.goTestFiles, third: M.clientTests },
    { doc: "README.md", anchor: /\*\*(\d+)\*\* Playwright journeys/,
        measure: M.playwrightTests },
    { doc: "README.md", anchor: /all (\d+) migrations\b/,
        measure: M.migrations },

    { doc: "ARCHITECTURE.md", anchor: /^(\d+) tables, no enums\./m,
        measure: M.models },
    { doc: "docs/data-model.md", anchor: /(\d+) tables, no enums/,
        measure: M.models },
    { doc: "docs/README.md", anchor: /What the (\d+) tables are for/,
        measure: M.models },

    { doc: "docs/testing.md", anchor: /\|\s*\*\*Go API\*\*.*\| (\d+) tests, (\d+) files \|/,
        measure: M.apiGoTests, second: M.apiGoTestFiles },
    { doc: "docs/testing.md", anchor: /\|\s*\*\*Realtime\*\*.*\| (\d+) tests, (\d+) files \|/,
        measure: M.rtGoTests, second: M.rtGoTestFiles },
    { doc: "docs/testing.md", anchor: /\|\s*\*\*Web\*\*.*\| (\d+) tests, (\d+) files \|/,
        measure: M.clientTests, second: M.clientTestFiles },
    { doc: "docs/testing.md", anchor: /(\d+) Playwright tests in (\d+) describe blocks/,
        measure: M.playwrightTests, second: M.playwrightJourneys },
];

// Per-row counts in docs/testing.md: the Go API row and the Realtime row share
// the module-wide Go counts in the table above, so only the Web row needs its
// own measurement. Kept as a separate anchor so the two rows cannot drift.

const BADGE_CLAIMS = [
    { doc: "README.md", badge: "next", measure: M.nextVersion, major: true },
    { doc: "README.md", badge: "go", measure: M.goVersion },
    {
        doc: "README.md",
        badge: "typescript",
        measure: () => bare(pkgVersion("client/package.json", "typescript")),
    },
];

// --- runner ------------------------------------------------------------------

const failures = [];
const errors = [];

function main() {
    for (const c of CLAIMS) checkOne(c.doc, c.anchor, c.measure, c.second, c.third);

    for (const c of BADGE_CLAIMS) {
        if (!exists(c.doc)) continue;
        const src = read(c.doc);
        const m = src.match(new RegExp(`${c.badge}-([0-9][0-9.]*)-`));
        if (!m) {
            errors.push(`${c.doc}: no ${c.badge} badge found`);
            continue;
        }
        const expected = c.measure();
        const want = c.major ? expected.split(".")[0] : expected;
        if (m[1] !== want) {
            failures.push(`${c.doc}: the ${c.badge} badge says ${m[1]}, the manifest says ${expected}`);
        }
    }

    summarise();
}

function checkOne(docRel, anchor, measure, second, third) {
    if (!exists(docRel)) {
        errors.push(`${docRel} does not exist`);
        return;
    }
    const src = read(docRel);
    const m = src.match(anchor);
    if (!m) {
        errors.push(`${docRel}: the anchor /${anchor.source}/ no longer matches. The document was restructured; update this file.`);
        return;
    }
    const actuals = [measure, second, third].filter(Boolean);
    actuals.forEach((fn, i) => {
        const expected = fn();
        if (Number(m[i + 1]) !== expected) {
            failures.push(`${docRel}: figure ${i + 1} says ${m[i + 1]}, repository has ${expected}  (/${anchor.source}/)`);
        }
    });
}

function summarise() {
    const ts = tsBreakdown();
    const rows = [
        ["tables", M.models()],
        ["migrations", M.migrations()],
        ["api routes", M.routes()],
        ["go tests", `${M.goTests()} in ${M.goTestFiles()} files`],
        ["client tests", `${M.clientTests()} in ${M.clientTestFiles()} files`],
        ["playwright", `${M.playwrightTests()} tests in ${M.playwrightJourneys()} journeys`],
        ["application lines", `${ts.app} ts/tsx`],
        ["test lines", `${ts.tests} ts/tsx`],
        ["migration sql lines", M.migrationSqlLines()],
        ["go source lines", M.goLines()],
        ["adrs", M.adrCount()],
        ["versions", `next ${M.nextVersion()} / go ${M.goVersion()} / vitest client ${M.vitestClient()}`],
    ];
    console.log("  measured");
    for (const [label, value] of rows) console.log(`    ${label.padEnd(22)}${value}`);
    console.log(`    ${"total".padEnd(22)}${ts.app + ts.tests + M.migrationSqlLines() + M.goLines()}`);
    console.log("");

    if (errors.length) {
        console.error("check-numbers could not check everything:\n");
        for (const e of errors) console.error(`  ${e}`);
        console.error("\nA claim whose anchor is missing is worse than a claim that is wrong,");
        console.error("because it stops being checked without saying so.\n");
        process.exit(2);
    }

    if (failures.length) {
        console.error(`check-numbers found ${failures.length} documented count(s) that disagree with the repository:\n`);
        for (const f of failures) console.error(`  ${f}`);
        console.error("\nFix the documentation, then fix this file in the same commit.");
        console.error("If a number is genuinely correct and the anchor is stale, update the anchor.\n");
        process.exit(1);
    }

    const checked = CLAIMS.length + BADGE_CLAIMS.length;
    console.log(`check-numbers: ${checked} documented counts agree with the repository.`);
}

console.log("check-numbers - documented counts against the repository\n");

try {
    main();
} catch (err) {
    console.error("check-numbers itself failed. This is a bug in scripts/check-numbers.js,\nnot a drift in the documentation:\n");
    console.error(`  ${err && err.stack ? err.stack : err}\n`);
    process.exit(2);
}
