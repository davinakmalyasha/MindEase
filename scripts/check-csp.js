// Evaluates the Content-Security-Policy that `client/next.config.mjs` builds, and
// fails if any directive is malformed or if the policy forbids the API it is
// configured to call.
//
// The bug this exists for is not theoretical.
//
// `connect-src` was hardcoded to
// `'self' https://api.dicebear.com https://*.up.railway.app wss:`, with a comment
// saying the API host would have to be edited per deployment. Editing it per
// deployment is exactly what nobody does, so it never was. `http://localhost:5000`
// was never permitted, the browser blocked every call to this application's own
// API, and sign-in rendered "Network Error" with nothing wrong with the API, the
// network, the credentials, or the code. That is the whole local development
// experience, and it is also all twelve Playwright journeys, because compose
// defaults NEXT_PUBLIC_API_URL to http://localhost:5000/api for the same reason.
//
// The fix derives the origins from NEXT_PUBLIC_API_URL and
// NEXT_PUBLIC_REALTIME_URL, so the header and the client bundle cannot disagree.
//
// And then the fix was wrong the first time: `"connect-src"` and its value went
// into the policy array as two separate elements, producing a header containing
// `connect-src; 'self' http://localhost:5000 ...`. A directive with no value is
// ignored by the browser, so the page still could not reach its API and the
// symptom was identical to the bug it was meant to fix. Nothing failed, because
// nothing checks whether a CSP is well-formed.
//
// Hence this file. `scripts/check-csp.test.js` has the policy-level cases,
// including that broken intermediate, as a permanent regression test.

const fs = require("fs");
const path = require("path");

const { parsePolicy } = require("./check-csp-lib.js");

// Imported, not required from `next.config.mjs`.
//
// It used to require the config, which imports `next-intl/plugin`, and the first
// CI run failed with:
//
//     Cannot find package 'next-intl' imported from client/next.config.mjs
//
// because this gate is the only one in the `docs` job that does not install
// dependencies. Every other gate reads files as text and runs on a bare checkout
// in about eight seconds; this one was the odd one out, and the odd one out is
// the one that eventually stops being run.
//
// So the policy lives in `client/lib/csp.mjs`, a module with no imports, and both
// the Next config and this gate consume it. One copy, no drift, and the check
// runs anywhere Node runs.
const POLICY_MODULE = path.join(__dirname, "..", "client", "lib", "csp.mjs");

async function evaluate({ isProduction, env }) {
  // Fresh instance per evaluation, so each configuration is built from scratch.
  delete require.cache[require.resolve(POLICY_MODULE)];
  const mod = await import(`file:///${POLICY_MODULE.replace(/\\/g, "/")}?v=${Date.now()}`);
  return mod.buildCsp({ isProduction, env });
}

const problems = [];

// 1. The local-development configuration, which is what compose uses. This is
//    the one that was broken.
const devEnv = {
  NEXT_PUBLIC_API_URL: "http://localhost:5000/api",
  NEXT_PUBLIC_REALTIME_URL: "ws://localhost:8080/ws",
  NEXT_PUBLIC_SENTRY_DSN: "",
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
};

// 2. A Railway-shaped configuration, so the production path is proven too.
const prodEnv = {
  NEXT_PUBLIC_API_URL: "https://mindease-api.up.railway.app/api",
  NEXT_PUBLIC_REALTIME_URL: "wss://mindease-rt.up.railway.app/ws",
  NEXT_PUBLIC_SENTRY_DSN: "https://abc123@o4507.ingest.sentry.io/456",
  NEXT_PUBLIC_SITE_URL: "https://mindease.app",
};

async function main() {
  // Both the shape CI builds (`next build`) and the shape `next dev` serves are
  // checked, because `script-src` is the one directive that differs between them
  // and a policy that is wrong only in development is wrong exactly when a
  // developer is looking at it.
  for (const [label, env, isProduction] of [
    ["local compose configuration", devEnv, false],
    ["production configuration", prodEnv, true],
  ]) {
    let policy;
    try {
      policy = await evaluate({ isProduction, env });
    } catch (e) {
      problems.push(`${label}: ${e.message}`);
      continue;
    }
    for (const p of parsePolicy(policy, env.NEXT_PUBLIC_API_URL)) {
      problems.push(`${label}: ${p}`);
    }
  }

  // A malformed API URL must degrade the policy, not break the build. The whole
  // point of `originOf` returning null rather than throwing.
  try {
    const policy = await evaluate({
      isProduction: true,
      env: { NEXT_PUBLIC_API_URL: "not a url", NEXT_PUBLIC_REALTIME_URL: "", NEXT_PUBLIC_SENTRY_DSN: "" },
    });
    for (const p of parsePolicy(policy, null)) problems.push(`malformed API url: ${p}`);
  } catch (e) {
    problems.push(`malformed API url: the policy builder threw instead of omitting the origin - ${e.message}`);
  }

  // Guard against the original defect being reintroduced as a literal, in either
  // file. This is a text check on top of a structural one, because the structural
  // check cannot tell "hardcoded" from "derived" when the derived value happens
  // to be a URL - and the hardcoded version is exactly what shipped.
  for (const file of [POLICY_MODULE, path.join(__dirname, "..", "client", "next.config.mjs")]) {
    const src = fs.readFileSync(file, "utf8");
    if (/connect-src[^`"']*'self'[^`"']*api\.dicebear/.test(src)) {
      problems.push(
        `${path.basename(file)}: connect-src is hardcoded again; derive it from NEXT_PUBLIC_* instead`
      );
    }
  }

  if (problems.length) {
    console.error(`check-csp found ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("");
    process.exit(1);
  }

  console.log("check-csp: the policy is well-formed and permits the configured API origin.");
  console.log("            verified a localhost configuration and a Railway-shaped one, in dev and build.");
}

main().catch((e) => {
  console.error(`check-csp could not run: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});