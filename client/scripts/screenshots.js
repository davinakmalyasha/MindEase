// Portfolio screenshot capture.
//
// Deliberately not a Playwright *spec*, so `npx playwright test` cannot run it
// and the documented test count stays the number of things that actually assert
// something. The first version of this was `e2e/screenshots.spec.ts`, and the
// count gate immediately reported 21 Playwright tests instead of 12 - nine extra
// "tests" that click around and take a picture. A test count that includes work
// which cannot fail is not a measurement of anything, and this repository's whole
// claim to credibility rests on those numbers being measured.
//
// Usage, against a seeded stack:
//
//     node scripts/screenshots.js
//
// Writes PNGs to ../docs/screenshots. Run it from a machine where the API is on
// http://localhost:5000 and the web app is on http://localhost:3000.

const path = require("path");
const fs = require("fs");
const { chromium } = require("@playwright/test");

const WEB = process.env.SCREENSHOT_WEB_URL || "http://localhost:3000";
const OUT = path.join(__dirname, "..", "..", "docs", "screenshots");

// Generous, because `next dev` compiles a route on first request and this
// machine is slow. The first version used Playwright's 30s default and timed out
// on a route that had just rendered in 4 seconds, because the request behind it
// had taken 37.
const NAV_TIMEOUT = Number(process.env.SCREENSHOT_TIMEOUT_MS || 120_000);

const ACCOUNTS = {
  patient: { email: "patient@mindease.app", password: "Patient@123" },
  doctor: { email: "dr1@mindease.app", password: "Doctor@123" },
  admin: { email: "admin@mindease.app", password: "Admin@123" },
};

async function login(page, who) {
  await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await page.getByLabel(/email/i).fill(who.email);
  await page.getByLabel(/password/i).fill(who.password);
  await page.getByRole("button", { name: /sign in|log in|masuk/i }).first().click();
  // Wait on leaving /login rather than on a specific destination: each role is
  // sent somewhere different, and where it goes is not what this script is for.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: NAV_TIMEOUT });
}

async function settle(page, ms = 1_200) {
  await page.waitForLoadState("networkidle").catch(() => {});
  // Several of these screens animate. A capture taken mid-transition reads as a
  // rendering bug to anyone who has not seen the app move.
  await page.waitForTimeout(ms);
}

async function shoot(page, name, fullPage = true) {
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
  console.log(`  captured ${name}.png`);
}

/**
 * Each entry names a page to visit after signing in as `as`.
 * A missing route is skipped with a note rather than aborting the run: a
 * screenshot script that produces nothing is worse than one that produces most
 * of what it was asked for.
 */
const SHOTS = [
  { name: "triage-queue", as: "doctor", url: "/dashboard/triage",
    caption: "The clinician triage queue. Every row is a disclosure that reached a person, not an automatic escalation." },
  { name: "patient-dashboard", as: "patient", url: "/dashboard",
    caption: "The patient dashboard." },
  { name: "mood-trend", as: "patient", url: "/dashboard/mood",
    caption: "Fourteen days of seeded mood history." },
  { name: "assessment", as: "patient", url: "/dashboard/assessment",
    caption: "Screening with an explicit insufficient-data state." },
  { name: "clinician-directory", as: "patient", url: "/doctors",
    caption: "The clinician directory. Availability is the clinician's own statement, and its absence is labelled." },
  { name: "admin-console", as: "admin", url: "/dashboard/admin",
    caption: "The admin console." },
  { name: "booking", as: "patient", url: "/booking",
    caption: "Booking." },
  { name: "messages", as: "patient", url: "/dashboard/messages",
    caption: "Messaging. A crisis phrase here raises an alert rather than being answered by a model." },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // One page per role, so the three sign-ins happen three times rather than nine.
  const byRole = new Map();
  for (const s of SHOTS) {
    if (!byRole.has(s.as)) byRole.set(s.as, []);
    byRole.get(s.as).push(s);
  }

  const captured = [];
  const skipped = [];

  for (const [role, shots] of byRole) {
    console.log(`\n${role}:`);
    try {
      await login(page, ACCOUNTS[role]);
    } catch (e) {
      console.error(`  could not sign in as ${role}: ${e.message}`);
      for (const s of shots) skipped.push([s.name, "login failed"]);
      continue;
    }

    for (const s of shots) {
      try {
        const res = await page.goto(`${WEB}${s.url}`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
        // A route that redirects to the sign-in page has silently failed.
        if (new URL(page.url()).pathname.startsWith("/login")) {
          throw new Error("redirected to /login");
        }
        await shoot(page, s.name);
        captured.push(s);
      } catch (e) {
        console.error(`  skipped ${s.name}: ${e.message}`);
        skipped.push([s.name, e.message]);
      }
    }

    // The SOS modal is per-role chrome rather than a route, so it is captured
    // from wherever that role happens to be.
    try {
      const sos = page.getByRole("button", { name: /sos|emergency|krisis|darurat/i }).first();
      if (await sos.count()) {
        await sos.click({ timeout: 5_000 });
        await settle(page, 900);
        await page.screenshot({ path: path.join(OUT, "sos-modal.png") });
        console.log("  captured sos-modal.png");
        captured.push({
          name: "sos-modal",
          caption: "The SOS control and its hotline list.",
        });
      }
    } catch (e) {
      console.error(`  skipped sos-modal: ${e.message}`);
      skipped.push(["sos-modal", e.message]);
    }
  }

  await browser.close();

  // A caption index, so the README does not have to hardcode a list that will
  // drift from the directory.
  const lines = ["# Screenshots", "", "Captured by `client/scripts/screenshots.js` against a seeded stack.", ""];
  for (const s of captured.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`## ${s.name}`, "", s.caption || "", "");
  }
  if (skipped.length) {
    lines.push("## Not captured", "");
    for (const [name, why] of skipped) lines.push(`- \`${name}\` - ${why}`);
    lines.push("");
  }
  fs.writeFileSync(path.join(OUT, "README.md"), lines.join("\n"), "utf8");

  console.log(`\n${captured.length} captured, ${skipped.length} skipped, index written to docs/screenshots/README.md`);
  // A run that captures nothing is a failure; a partial run is reported, not fatal.
  if (captured.length === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});