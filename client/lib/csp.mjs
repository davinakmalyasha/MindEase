// The Content-Security-Policy for the web app.
//
// Extracted out of `next.config.mjs` so that it can be tested without Next.
//
// The reason is not tidiness. `next.config.mjs` imports `next-intl/plugin`, so a
// gate that required the config to read the header needed `npm ci` first. In CI
// that meant the policy check belonged to a job that installs the client's whole
// dependency tree, and the first run of it failed exactly there:
//
//     Cannot find package 'next-intl' imported from client/next.config.mjs
//
// The other gates in this directory - the workflow checker, the label checker,
// the translation-key checker - run on a bare checkout in about eight seconds,
// because they read files as text. This one was the odd one out, and the odd one
// out is the one that stops being run.
//
// So the policy is a pure function of its inputs, in a file with no imports, and
// both the config and `scripts/check-csp.js` use it. There is no second copy of
// the policy to drift, and the check runs anywhere Node runs.

/**
 * The origin of a configured endpoint, for `connect-src`.
 *
 * Returns `null` rather than throwing on an unparseable value, because a
 * malformed `NEXT_PUBLIC_API_URL` should produce a policy that simply omits it.
 * The request then fails loudly with a CSP error naming the directive, which is a
 * better failure than a build that will not start.
 */
export const originOf = (value) => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

/**
 * `connect-src`: where the API, the realtime socket and error reporting may go.
 *
 * ## Why this is not a hardcoded list
 *
 * It was one: `'self' https://api.dicebear.com https://*.up.railway.app wss:`,
 * with a comment saying the API host would have to be edited per deployment.
 * Editing it per deployment is exactly what nobody does, so it never was, and
 * `http://localhost:5000` was never permitted. The browser obeyed the header and
 * refused every call to this application's own API: sign-in rendered
 * `Network Error` with nothing wrong with the API, the network, the credentials
 * or the code. Because compose defaults `NEXT_PUBLIC_API_URL` to
 * `http://localhost:5000/api` for the same reason, this was also all twelve
 * Playwright journeys.
 *
 * Deriving the list from the same variables the client bundle inlines means the
 * header and the bundle cannot disagree - which is the failure a hardcoded list
 * guarantees.
 *
 * ## The two broad entries
 *
 * `wss:` stays because `https:` does not cover a WebSocket origin:
 * `wss://api.up.railway.app` is not matched by `https://*.up.railway.app`, so
 * narrowing to hosts would silently break the realtime socket in production.
 *
 * The Sentry hosts are here because `lib/sentry.ts` wires up client-side error
 * reporting the moment `NEXT_PUBLIC_SENTRY_DSN` is set, and without them the
 * browser drops every event on the floor. There is no visible failure for
 * missing telemetry; it is the easiest kind of breakage to ship and the hardest
 * to notice.
 */
export const connectSrc = (env = {}) => {
  const sources = [
    "'self'",
    originOf(env.NEXT_PUBLIC_API_URL),
    originOf(env.NEXT_PUBLIC_REALTIME_URL),
    originOf(env.NEXT_PUBLIC_SENTRY_DSN),
    "https://api.dicebear.com",
    "https://*.up.railway.app",
    "wss:",
  ].filter(Boolean);

  return `connect-src ${sources.join(" ")}`;
};

/**
 * The full policy.
 *
 * @param {boolean} isProduction relaxes the development-only script allowances
 * @param {Record<string, string|undefined>} env the `NEXT_PUBLIC_*` values
 * @returns {string} a `; `-joined policy
 */
export const buildCsp = ({ isProduction = true, env = {} } = {}) => {
  return [
    "default-src 'self'",
    // Next injects a small inline bootstrap; the hash-less form is required in
    // development where the payload differs on every edit.
    isProduction
      ? "script-src 'self' 'unsafe-inline'"
      : "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    connectSrc(env),
    // Only the degraded jitsi fallback needs a frame source. A livekit session
    // connects with the SDK and frames nothing, so on a fully configured
    // deployment this can be removed outright.
    "frame-src https://meet.jit.si",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Valueless by specification. A checker that treats this as malformed is a
    // checker crying wolf, which is how a gate gets ignored.
    "upgrade-insecure-requests",
  ].join("; ");
};