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

const CONFIG = path.join(__dirname, "..", "client", "next.config.mjs");

/** Load next.config.mjs with `env` applied, and return its `/ :path *` CSP. */
async function evaluate(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    // Fresh instance per evaluation, so `headers()` sees the env applied above.
    delete require.cache[require.resolve(CONFIG)];
    const mod = require(CONFIG);
    const routes = await mod.default.headers();
    if (!Array.isArray(routes)) throw new Error("headers() did not return an array");
    for (const r of routes) {
      const h = (r.headers || []).find((x) => x.key.toLowerCase() === "content-security-policy");
      if (h) return h.value;
    }
    throw new Error("no Content-Security-Policy header on /:path*");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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
  for (const [label, env] of [
    ["local compose configuration", devEnv],
    ["production configuration", prodEnv],
  ]) {
    let policy;
    try {
      policy = await evaluate(env);
    } catch (e) {
      problems.push(`${label}: ${e.message}`);
      continue;
    }
    for (const p of parsePolicy(policy, env.NEXT_PUBLIC_API_URL)) {
      problems.push(`${label}: ${p}`);
    }
  }

  // 3. A malformed API URL must degrade the policy, not break the build. The
  //    whole point of `originOf` returning null rather than throwing.
  try {
    const policy = await evaluate({
      NEXT_PUBLIC_API_URL: "not a url",
      NEXT_PUBLIC_REALTIME_URL: "",
      NEXT_PUBLIC_SENTRY_DSN: "",
    });
    for (const p of parsePolicy(policy, null)) problems.push(`malformed API url: ${p}`);
  } catch (e) {
    problems.push(`malformed API url: the config threw instead of omitting the origin - ${e.message}`);
  }

  // 4. Guard against the original defect being reintroduced as a literal.
  const src = fs.readFileSync(CONFIG, "utf8");
  if (/connect-src[^`"']*'self'[^`"']*api\.dicebear/.test(src)) {
    problems.push(
      "next.config.mjs: connect-src is hardcoded again; derive it from NEXT_PUBLIC_* instead"
    );
  }

  if (problems.length) {
    console.error(`check-csp found ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("");
    process.exit(1);
  }

  console.log("check-csp: the policy is well-formed and permits the configured API origin.");
  console.log("            verified a localhost configuration and a Railway-shaped one.");
}

main().catch((e) => {
  console.error(`check-csp could not run: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});