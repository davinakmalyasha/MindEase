"use strict";

/**
 * The CSP parser shared by `check-csp.js` and its self-test.
 *
 * Split out so the test can exercise the rules directly on policies, instead of
 * only on whatever `next.config.mjs` currently produces. A checker whose test
 * asserts nothing but "the current file is fine" cannot detect a rule that has
 * quietly stopped working, which is the failure mode this whole exercise keeps
 * running into.
 */

// Directives that legitimately carry no value by specification. Getting this
// wrong in the other direction is how a checker starts crying wolf - the first
// version of this treated `upgrade-insecure-requests` as a broken directive.
const VALUELESS = new Set(["upgrade-insecure-requests", "block-all-mixed-content"]);

// The directives a policy must have to be meaningful, and what each one protects.
// `connect-src` is the one that actually bit; the rest are here so a future edit
// that drops one is a failure rather than a downgrade nobody notices.
const REQUIRED = {
  "default-src": "the fallback for every directive that is absent",
  "script-src": "XSS",
  "connect-src": "API and WebSocket calls",
  "img-src": "avatar and hero images",
  "frame-src": "the jitsi fallback",
  "object-src": "plugin content",
  "base-uri": "base-tag hijacking",
  "form-action": "form exfiltration",
  "frame-ancestors": "clickjacking",
};

/**
 * Parse and validate a policy.
 *
 * @param {string} policy the full header value
 * @param {string} [apiUrl] the configured API URL; when given, `connect-src`
 *   must permit its origin. This is the regression assertion.
 * @returns {string[]} problems; empty means well-formed
 */
function parsePolicy(policy, apiUrl) {
  const problems = [];
  if (!policy) return ["no policy to check"];

  const directives = new Map();

  for (const part of policy.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const sp = trimmed.indexOf(" ");
    const name = sp === -1 ? trimmed : trimmed.slice(0, sp);
    const value = sp === -1 ? "" : trimmed.slice(sp + 1).trim();

    if (!value && !VALUELESS.has(name)) {
      problems.push(`"${name}" has no value - the browser ignores the whole directive`);
      continue;
    }
    if (VALUELESS.has(name) && value) {
      problems.push(`"${name}" is valueless but was given "${value}"`);
    }
    if (directives.has(name)) {
      problems.push(`"${name}" appears more than once; only the first is honoured`);
    }
    directives.set(name, value);
  }

  for (const [name, why] of Object.entries(REQUIRED)) {
    if (!directives.has(name)) problems.push(`no "${name}" (${why})`);
  }

  // The regression test. If the API origin is configured but not permitted, the
  // application cannot log anybody in - and it fails as "Network Error" in the
  // UI, which points at the network rather than at a header.
  if (apiUrl) {
    const connect = directives.get("connect-src");
    if (connect) {
      let origin = null;
      try {
        origin = new URL(apiUrl).origin;
      } catch {
        origin = null;
      }
      if (origin && !connect.includes(origin)) {
        problems.push(`connect-src does not allow the API origin ${origin}`);
      }
    }
  }

  return problems;
}

module.exports = { parsePolicy, REQUIRED, VALUELESS };