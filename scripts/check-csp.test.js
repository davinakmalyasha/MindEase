// Proves scripts/check-csp.js fails on the two policies it was written for, and
// passes on the one it was written to produce.
//
// The second case matters more than the first. The `connect-src` fix was wrong
// on its first attempt - `"connect-src"` and its value went into the policy array
// as two elements, so the served header contained `connect-src; 'self'
// http://localhost:5000 ...`. The browser ignores an empty directive, so the page
// still could not reach its API and the symptom was identical to the original
// bug. Nothing in the build complained. This case is what makes that failure
// impossible to repeat silently.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// The parser is the thing under test, so it is exercised directly on policies
// rather than through next.config.mjs. The end-to-end assertions against the
// real config live in check-csp.js itself.
const { parsePolicy } = require("./check-csp-lib.js");

const cases = [
  {
    name: "the policy as it shipped: no local API origin",
    policy:
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https:; connect-src 'self' https://api.dicebear.com " +
      "https://*.up.railway.app wss:; frame-src https://meet.jit.si; media-src 'self' blob:; " +
      "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " +
      "upgrade-insecure-requests",
    api: "http://localhost:5000/api",
    expect: (p) => p.some((x) => /connect-src does not allow the API origin/.test(x)),
  },
  {
    name: "the broken first fix: directive split from its value",
    policy:
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https:; connect-src; 'self' http://localhost:5000 " +
      "ws://localhost:8080 https://api.dicebear.com https://*.up.railway.app wss:; " +
      "frame-src https://meet.jit.si; media-src 'self' blob:; object-src 'none'; " +
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
    api: "http://localhost:5000/api",
    // Flagged twice, and correctly so: the empty directive is malformed, and
    // because it is skipped it never lands in the map, so `connect-src` counts as
    // absent. There is no third "does not allow the API origin" finding, because
    // there is no usable directive left to compare an origin against.
    expect: (p) =>
      p.some((x) => /"connect-src" has no value/.test(x)) &&
      p.some((x) => /no "connect-src"/.test(x)),
  },
  {
    name: "a duplicated directive, where only the first is honoured",
    policy:
      "default-src 'self'; script-src 'self'; connect-src 'self' http://localhost:5000; " +
      "connect-src 'self' https://evil.example; object-src 'none'; base-uri 'self'; " +
      "form-action 'self'; frame-ancestors 'none'; img-src 'self'; frame-src https://meet.jit.si",
    api: "http://localhost:5000/api",
    expect: (p) => p.some((x) => /appears more than once/.test(x)),
  },
  {
    name: "a dropped hardening directive",
    policy:
      "default-src 'self'; script-src 'self'; connect-src 'self' http://localhost:5000; " +
      "img-src 'self'; frame-src https://meet.jit.si; media-src 'self' blob:",
    api: "http://localhost:5000/api",
    expect: (p) => ["object-src", "base-uri", "form-action", "frame-ancestors"].every((d) => p.some((x) => x.includes(`no "${d}"`))),
  },
  {
    name: "the fixed policy, for a localhost deployment",
    policy:
      "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; " +
      "connect-src 'self' http://localhost:5000 ws://localhost:8080 " +
      "https://api.dicebear.com https://*.up.railway.app wss:; " +
      "frame-src https://meet.jit.si; media-src 'self' blob:; object-src 'none'; " +
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
    api: "http://localhost:5000/api",
    expect: (p) => p.length === 0,
  },
  {
    name: "the fixed policy, for a Railway deployment",
    policy:
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' " +
      "https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; " +
      "img-src 'self' data: blob: https:; " +
      "connect-src 'self' https://mindease-api.up.railway.app " +
      "wss://mindease-rt.up.railway.app https://o4507.ingest.sentry.io " +
      "https://api.dicebear.com https://*.up.railway.app wss:; " +
      "frame-src https://meet.jit.si; media-src 'self' blob:; object-src 'none'; " +
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
    api: "https://mindease-api.up.railway.app/api",
    expect: (p) => p.length === 0,
  },
];

let failed = 0;
for (const c of cases) {
  const problems = parsePolicy(c.policy, c.api);
  let ok = false;
  try {
    assert.ok(c.expect(problems), `expected the finding set to include the point of this case, got: ${JSON.stringify(problems)}`);
    ok = true;
  } catch (e) {
    console.error(e.message);
  }
  if (ok) console.log(`ok   ${c.name}`);
  else {
    failed += 1;
    console.error(`FAIL ${c.name}`);
  }
}

if (failed) {
  console.error(`\n${failed} of ${cases.length} case(s) failed - the parser may be broken.`);
  process.exit(1);
}
console.log(`\ncheck-csp self-test: ${cases.length} cases passed.`);