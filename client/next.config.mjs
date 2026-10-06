import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import createNextIntlPlugin from "next-intl/plugin";
import { buildCsp } from "./lib/csp.mjs";

/**
 * @typedef {import('next').NextConfig} NextConfig
 */

const isProduction = process.env.NODE_ENV === "production";

/**
 * A stable identifier for this build, used to version the service worker cache.
 *
 * The worker previously kept a hard-coded `mindease-v1` name, so its `activate`
 * handler *preserved* stale JavaScript and RSC payloads across deploys — a
 * released fix would not reach a returning user until the cache was cleared by
 * hand. Deriving the id from the worker source plus the build environment means
 * any change to caching behaviour produces a new cache, which `activate` then
 * prunes.
 *
 * `GIT_SHA` is preferred so the id matches the deployed commit; the source hash
 * is the fallback for local builds.
 */
const BUILD_PLACEHOLDER = "self.__MINDSW_BUILD__ = \"__MINDSW_BUILD__\"";

/**
 * The worker source with any previously-stamped build id removed.
 *
 * The stamped value is written back into this file, so hashing the file as-is
 * would fold the *previous* build's id into the next one and change the cache
 * name on every build — invalidating every returning visitor's cache even when
 * nothing changed. Hashing the normalised source makes the id depend only on
 * the worker's behaviour.
 */
const normaliseWorker = (source) =>
  source.replace(/self\.__MINDSW_BUILD__\s*=\s*"[^"]*"/g, BUILD_PLACEHOLDER);

const buildIdentity = () => {
  if (process.env.NEXT_PUBLIC_BUILD_ID) return process.env.NEXT_PUBLIC_BUILD_ID;
  if (process.env.GIT_SHA) return process.env.GIT_SHA.slice(0, 12);
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12);

  const workerPath = path.join(process.cwd(), "public", "sw.js");
  if (existsSync(workerPath)) {
    const hash = createHash("sha256").update(normaliseWorker(readFileSync(workerPath, "utf8")));
    return hash.digest("hex").slice(0, 12);
  }
  return "dev";
};

/**
 * Substitutes the build id into `public/sw.js`.
 *
 * The worker lives in `public/` so it is served verbatim at the root scope, and
 * therefore cannot be bundled — so the one value it needs has to be substituted
 * as a build step.
 */
const stampServiceWorker = () => {
  const workerPath = path.join(process.cwd(), "public", "sw.js");
  if (!existsSync(workerPath)) return;

  const build = buildIdentity();
  const original = readFileSync(workerPath, "utf8");
  if (!original.includes("__MINDSW_BUILD__")) return;

  const stamped = original.replace(
    /self\.__MINDSW_BUILD__\s*=\s*"[^"]*"/g,
    `self.__MINDSW_BUILD__ = ${JSON.stringify(build)}`
  );

  // Only write when the content actually changes, so a rebuild does not
  // invalidate every returning visitor's cache.
  if (stamped !== original) {
    writeFileSync(workerPath, stamped, "utf8");
  }
};


/** @type {NextConfig} */
const nextConfig = {
  output: "standalone",

  reactStrictMode: true,
  poweredByHeader: false,

  // Next 16 generates `client/AGENTS.md` and `client/CLAUDE.md` on `next dev`.
  // Both are ignored in `.gitignore`, but ignoring them is the second line of
  // defence: this repository already has a curated root `AGENTS.md` describing
  // the deploy paths, the secret rules and the test gates, and an auto-generated
  // file one directory down describing the same project in a different way is
  // worse than no second file. An agent reading the nearest one gets the
  // generated version.
  agentRules: false,

  // The development overlay badge ("N Issues") renders into the page, so it
  // appears in every screenshot, in every Playwright trace, and in anything a
  // reviewer opens the dev server to look at. Its error count is also not
  // something a screenshot should be quietly asserting either way.
  devIndicators: false,

  images: {
    // Avatars are rendered from dicebear as SVG. The sandbox below neutralises
    // the script-execution risk of serving a remote SVG through the optimizer.
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "api.dicebear.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "images.unsplash.com",
        pathname: "/**",
      },
    ],
  },

  // Transitive dependencies that are not imported directly. Without this the
  // barrel file pulls its whole index into any icon import.
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns", "framer-motion"],
  },

  /**
   * Response headers.
   *
   * The API sets Helmet, but this is the tier the browser actually loads, and
   * it previously sent no security headers at all. The CSP is deliberately
   * strict: there is no inline script requirement in the App Router, and
   * `unsafe-inline` in `script-src` would void the benefit of having one.
   */
  async headers() {
    const csp = buildCsp({ isProduction, env: process.env });

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            // The product needs camera and microphone for video consultations,
            // and nothing else.
            value: "camera=(self), microphone=(self), geolocation=(), payment=(self), usb=(), interest-cohort=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      {
        // The service worker must never be cached, or a released fix can never
        // reach a returning visitor.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/offline",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },
};

stampServiceWorker();

/**
 * `createNextIntlPlugin` is what makes `getTranslations()` resolve on the
 * server. Without it the client half of next-intl still works (the root layout
 * imports `messages/*.json` directly), which is why the missing plugin was not
 * obvious: every Server Component calling `getTranslations` threw instead.
 */
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

export default withNextIntl(nextConfig);
