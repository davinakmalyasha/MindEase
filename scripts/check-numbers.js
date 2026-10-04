#!/usr/bin/env node
/**
 * Fails the build when a number written in the documentation disagrees with the
 * repository.
 *
 * Why this exists
 * ---------------
 * Every count in this repository is hand-maintained: "27 models", "125 routes",
 * "427 tests", "15 migrations". A previous pass corrected all of them, and the
 * next pass found fifteen that had drifted again — a stale test count in two CI
 * comments, a per-file table that summed to a different number than its own
 * heading, an architecture document that described a test suite from two
 * releases earlier.
 *
 * The problem is not carelessness. It is that nothing checked. The counts are
 * true when written and silently false three commits later, and a reader has no
 * way to tell which is which without re-running the measurement themselves.
 *
 * So the measurement lives here, once, and the documentation has to agree with
 * it. This is the same argument as the schema-drift gate, applied to prose: a
 * gate that has never been run is a comment, and a number that is never
 * re-derived is a comment too.
 *
 * When a count is legitimately wrong, fix the documentation first and then this
 * file in the same commit — the failure message names both.
 *
 * Exit codes: 0 in sync, 1 on a mismatch, 2 on a configuration error (a claim
 * whose anchor text is no longer in the document, which means the document was
 * restructured and this file needs to follow).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// --- tiny file helpers -------------------------------------------------------

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/** Every tracked-ish source file under `rel`, recursively. */
function walk(rel, out = []) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(child, out);
    else out.push(child);
  }
  return out;
}

function lineCount(rel) {
  return read(rel).split("\n").length;
}

// --- measurements ------------------------------------------------------------

const M = {};

/**
 * Count `model X {` blocks in the Prisma datamodel.
 *
 * Indentation-agnostic on purpose. A previous version of this script anchored on
 * `^model`, which matched 26 of 27 models because one of them was indented a
 * single space out from every other — so the count was wrong in the one
 * direction nobody would notice, and the datamodel is the source of truth for
 * every other count here.
 */
M.models = () => (read("server/prisma/schema.prisma").match(/^\s*model\s+\w+\s*\{/gm) || []).length;

/** This datamodel declares no `enum` block. That is a deliberate design decision. */
M.enums = () => (read("server/prisma/schema.prisma").match(/^\s*enum\s+\w+\s*\{/gm) || []).length;

/** Prisma `@@index` declarations. */
M.prismaIndexes = () => (read("server/prisma/schema.prisma").match(/@@index\s*\(/g) || []).length;

M.migrations = () =>
  fs
    .readdirSync(path.join(ROOT, "server/prisma/migrations"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, "server/prisma/migrations", d.name, "migration.sql")))
    .length;

/**
 * Registered API routes.
 *
 * Counted from the router registrations rather than a hand-maintained list, and
 * deliberately NOT including the five endpoints `app.ts` mounts outside any
 * router (`/api/csrf-token`, `/api/health`, `/api/health/db`,
 * `/api/openapi.json` and the `/api/docs` mount). The documented figure is the
 * router count; the difference is stated in the same sentence in the README so
 * a reader who counts differently is not left thinking they found an error.
 */
M.routes = () => {
  const files = fs.readdirSync(path.join(ROOT, "server/src/routes")).filter((f) => f.endsWith(".routes.ts"));
  let n = 0;
  for (const f of files) {
    const src = read(`server/src/routes/${f}`);
    n += (src.match(/\brouter\.(get|post|put|patch|delete)\s*\(/g) || []).length;
  }
  return n;
};

/** `it(` / `test(` occurrences in a test file, minus the skipped ones. */
function countCases(src) {
  const all = (src.match(/^\s*(?:it|test)\s*\(/gm) || []).length;
  const skipped = (src.match(/^\s*(?:it|test)\.(?:skip|todo|each)\s*\(/gm) || []).length;
  const each = (src.match(/^\s*(?:it|test)\.each\b/gm) || []).length;
  return all - skipped + each;
}

/**
 * Test files in a suite.
 *
 * `.tsx` is matched as well as `.ts`, and it has to be: `client/tests` contains
 * one `.test.tsx` file, so a `.ts`-only filter counted five client test files
 * where the documentation correctly said six. A measurement that is wrong in
 * the direction that makes the repository look worse is still wrong.
 */
function suite(rel, dir) {
  const files = walk(`${rel}/${dir}`).filter((f) => /\.test\.tsx?$/.test(f));
  return { files: files.length, tests: files.reduce((n, f) => n + countCases(read(f)), 0) };
}

M.serverTests = () => suite("server", "tests").tests;
M.serverTestFiles = () => suite("server", "tests").files;
M.clientTests = () => suite("client", "tests").tests;
M.clientTestFiles = () => suite("client", "tests").files;
/** Top-level `func TestXxx` declarations across the module. */
M.goTests = () =>
  walk("server-realtime")
    .filter((f) => f.endsWith("_test.go"))
    .reduce((n, f) => n + (read(f).match(/^func Test/gm) || []).length, 0);

M.goTestFiles = () => walk("server-realtime").filter((f) => f.endsWith("_test.go")).length;

M.goLines = () =>
  walk("server-realtime")
    .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
    .reduce((n, f) => n + lineCount(f), 0);

M.playwrightTests = () => {
  const files = walk("client/e2e").filter((f) => f.endsWith(".spec.ts"));
  return files.reduce((n, f) => n + (read(f).match(/^\s*test\s*\(/gm) || []).length, 0);
};

M.playwrightJourneys = () => {
  const files = walk("client/e2e").filter((f) => f.endsWith(".spec.ts"));
  return files.reduce((n, f) => n + (read(f).match(/test\.describe\s*\(/g) || []).length, 0);
};

/**
 * Lines of application code, tests, and migration SQL.
 *
 * Reported as three separate numbers because they answer three separate
 * questions, and because a single "total" invites the mistake this script exists
 * to catch: a total that quietly excludes one of the languages it names.
 */
function tsBreakdown() {
  const isSource = (f) => /\.tsx?$/.test(f);
  let app = 0;
  let tests = 0;
  for (const f of walk("server/src")) if (isSource(f)) app += lineCount(f);
  for (const f of walk("client/app").concat(walk("client/components"), walk("client/lib"), walk("client/hooks"), walk("client/context")))
    if (isSource(f)) app += lineCount(f);
  for (const f of walk("server/tests")) if (isSource(f)) tests += lineCount(f);
  for (const f of walk("client/tests")) if (isSource(f)) tests += lineCount(f);
  return { app, tests };
}

M.appLines = () => tsBreakdown().app;
M.testLines = () => tsBreakdown().tests;
M.migrationSqlLines = () =>
  fs
    .readdirSync(path.join(ROOT, "server/prisma/migrations"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .reduce((n, d) => {
      const f = path.join(ROOT, "server/prisma/migrations", d.name, "migration.sql");
      return n + (fs.existsSync(f) ? lineCount(path.relative(ROOT, f)) : 0);
    }, 0);

M.adrCount = () => fs.readdirSync(path.join(ROOT, "docs/adr")).filter((f) => /^\d{4}-.+\.md$/.test(f) && f !== "0000-template.md").length;

function pkgVersion(rel, dep) {
  const p = JSON.parse(read(rel));
  return (p.dependencies && p.dependencies[dep]) || (p.devDependencies && p.devDependencies[dep]) || "";
}

/** `6.12.0` from `^6.12.0`, and `6.12.0` from `6.12.0`. */
const bare = (v) => String(v).replace(/^[\^~>=<\s]*/, "").split(".").slice(0, 2).join(".");

M.prismaVersion = () => bare(pkgVersion("server/package.json", "@prisma/client"));
M.nextVersion = () => bare(pkgVersion("client/package.json", "next"));
M.goVersion = () => (read("server-realtime/go.mod").match(/^go\s+(\S+)/m) || [, ""])[1];
M.vitestServer = () => bare(pkgVersion("server/package.json", "vitest"));
M.vitestClient = () => bare(pkgVersion("client/package.json", "vitest"));

// --- claims ------------------------------------------------------------------
//
// `anchor` is a regex whose FIRST capture group must equal the measured value.
// If the anchor no longer matches at all, that is reported as a configuration
// error rather than silently passing: a restructured document that quietly
// stops being checked is exactly the failure mode this file exists to prevent.
//
// Every anchor below was read out of the document it checks rather than guessed,
// for the same reason. Two of the first drafts of this file asserted anchors
// that had never existed in any file.

const CLAIMS = [
  // README's "by the numbers" table. Four rows, each a separate measurement.
  { doc: "README.md", anchor: /\*\*(\d+)\*\* \| API routes .*\*\*(\d+)\*\* Prisma models .*\*\*(\d+)\*\* migrations/,
    measure: M.routes, second: M.models, third: M.migrations },
  { doc: "README.md", anchor: /\*\*(\d+)\*\* \| server tests across (\d+) files/,
    measure: M.serverTests, second: M.serverTestFiles },
  { doc: "README.md", anchor: /\*\*(\d+)\*\* \| client unit tests .*\*\*(\d+)\*\* Go tests/,
    measure: M.clientTests, second: M.goTests },
  { doc: "README.md", anchor: /\*\*(\d+)\*\* Playwright journeys/,
    measure: M.playwrightTests },
  { doc: "README.md", anchor: /all (\d+) migrations\b/,
    measure: M.migrations },

  // The same figures quoted in prose further down, so the table and the prose
  // cannot drift apart either.
  { doc: "README.md", anchor: /make test .*# (\d+) server tests/,
    measure: M.serverTests },
  { doc: "README.md", anchor: /schema-drift gate\*\*, (\d+) tests against a MySQL service container/,
    measure: M.serverTests },

  { doc: "ARCHITECTURE.md", anchor: /^(\d+) models, no enums\./m,
    measure: M.models },

  { doc: "docs/data-model.md", anchor: /(\d+) tables, no enums/,
    measure: M.models },
  { doc: "docs/README.md", anchor: /What the (\d+) tables are for/,
    measure: M.models },

  { doc: "docs/testing.md", anchor: /\|\s*\*\*Server\*\*.*\| (\d+) tests, (\d+) files \|/,
    measure: M.serverTests, second: M.serverTestFiles },
  { doc: "docs/testing.md", anchor: /\|\s*\*\*Realtime\*\*.*\| (\d+) tests, (\d+) files \|/,
    measure: M.goTests, second: M.goTestFiles },
  { doc: "docs/testing.md", anchor: /\|\s*\*\*Web\*\*.*\| (\d+) tests, (\d+) files \|/,
    measure: M.clientTests, second: M.clientTestFiles },
  { doc: "docs/testing.md", anchor: /(\d+) Playwright tests in (\d+) `test\.describe` blocks/,
    measure: M.playwrightTests, second: M.playwrightJourneys },
  { doc: "docs/testing.md", anchor: /^## The (\d+) server test files/m,
    measure: M.serverTestFiles },
];

// Version claims live in badge URLs, which are checked separately so a badge that
// renders the wrong version fails even though the surrounding prose is prose.
//
// `major: true` compares only the major version. The shields.io convention for
// the framework badges is the major (`next-16`), while the library badges
// (`prisma-6.12`) are pinned to the minor so a minor bump is visible without
// editing the badge. Both are deliberate; the distinction is recorded here
// because a check that is stricter than the convention it polices gets "fixed"
// by deleting the check.
const BADGE_CLAIMS = [
  { doc: "README.md", badge: "prisma", measure: M.prismaVersion },
  { doc: "README.md", badge: "next", measure: M.nextVersion, major: true },
  {
    doc: "README.md",
    badge: "typescript",
    measure: () => {
      const v = bare(pkgVersion("server/package.json", "typescript"));
      return `${v.split(".")[0]}.${v.split(".")[1]}`;
    },
  },
];

// --- runner ------------------------------------------------------------------

const failures = [];
const errors = [];

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

console.log("check-numbers — documented counts against the repository\n");

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

// The measured values themselves are worth printing even when everything agrees:
// this doubles as `make numbers`, which is how a contributor finds out what the
// current counts are without reading three documents and trusting them.
const ts = tsBreakdown();
const rows = [
  ["prisma models", `${M.models()}  (enums ${M.enums()})`],
  ["@@index declarations", M.prismaIndexes()],
  ["migrations", M.migrations()],
  ["api routes (routers)", M.routes()],
  ["server tests", `${M.serverTests()} in ${M.serverTestFiles()} files`],
  ["client tests", `${M.clientTests()} in ${M.clientTestFiles()} files`],
  ["go tests", `${M.goTests()} in ${M.goTestFiles()} files`],
  ["playwright", `${M.playwrightTests()} tests in ${M.playwrightJourneys()} journeys`],
  ["application lines", `${ts.app} ts/tsx`],
  ["test lines", `${ts.tests} ts/tsx`],
  ["migration sql lines", M.migrationSqlLines()],
  ["go source lines", M.goLines()],
  ["adrs", M.adrCount()],
  ["versions", `prisma ${M.prismaVersion()} / next ${M.nextVersion()} / go ${M.goVersion()} / vitest server ${M.vitestServer()} client ${M.vitestClient()}`],
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

console.log(`check-numbers: ${CLAIMS.length + BADGE_CLAIMS.length} documented counts agree with the repository.`);