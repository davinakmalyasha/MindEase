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

/**
 * Remove the chrome that is not the page.
 *
 * Three things overlay the content and none of them belongs in a README:
 *
 *   - the cookie consent panel, which sat on top of the triage queue in the
 *     first capture;
 *   - the "enable notifications?" prompt, in the bottom right;
 *   - the Next.js development overlay, which rendered "3 Issues" into the
 *     bottom-left of every screenshot.
 *
 * Consent is pre-set rather than clicked. Clicking is racy: the panel is
 * `position: fixed`, re-mounts on every client navigation, and a click that
 * lands during hydration does nothing at all. Writing the same key the banner
 * writes is deterministic and uses the product's own storage contract, so if
 * that key ever changes this stops working loudly rather than silently.
 *
 * The dev overlay is deleted from the DOM. `devIndicators: false` is set in
 * `next.config.mjs` as well, but the element is removed regardless - config that
 * only takes effect after a restart is not something a capture script should
 * depend on.
 */
const CONSENT_KEY = "mindease-cookie-consent";

async function prepareContext(context) {
  await context.addInitScript(
    ([key]) => {
      try {
        window.localStorage.setItem(key, "declined");
      } catch {
        // Private mode, or storage disabled. The banner simply appears and is
        // removed below.
      }
    },
    [CONSENT_KEY]
  );
}

async function stripOverlays(page) {
  await page
    .evaluate(() => {
      // Next.js dev overlay and its badge.
      for (const el of document.querySelectorAll("nextjs-portal")) el.remove();

      // Anything that looks like the consent panel or a notification prompt.
      // Found by text rather than by class, because the class is a utility
      // string that changes whenever the design does.
      //
      // The element carrying the text is rarely the one to remove - the heading
      // sits deep inside a `position: fixed` panel. So: take the *innermost*
      // element containing the text (last in document order), then walk up to the
      // nearest positioned ancestor. The first version matched only direct text
      // children of a container, which missed both panels because their headings
      // are wrapped in an `h2`/`h3`.
      const removeContaining = (needle) => {
        const all = [...document.querySelectorAll("body *")].filter(
          (el) => (el.textContent || "").includes(needle)
        );
        const innermost = all[all.length - 1];
        if (!innermost) return false;
        const panel = innermost.closest('[class*="fixed"], [class*="absolute"]') || innermost;
        panel.remove();
        return true;
      };

      removeContaining("Cookies & privacy");
      removeContaining("Enable notifications?");
    })
    .catch(() => {});
}

async function settle(page, ms = 1_200) {
  await page.waitForLoadState("networkidle").catch(() => {});
  // Several of these screens animate. A capture taken mid-transition reads as a
  // rendering bug to anyone who has not seen the app move.
  await page.waitForTimeout(ms);
}

async function shoot(page, name, fullPage = true) {
  await settle(page);
  await stripOverlays(page);
  // Toast and prompt components settle on their own timers; wait them out so
  // they are not mid-animation in the capture.
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
  console.log(`  captured ${name}.png`);
}

/**
 * Each entry names a page to visit after signing in as `as`.
 *
 * The paths are the ones that actually exist. The first version of this list
 * invented `/dashboard/triage` and `/booking` from how the product is described
 * rather than from `client/app/`, so both 404'd and the run reported a
 * "skipped" page as though the route were merely unavailable. A screenshot list
 * is a claim about what the application has, and it should be checked against the
 * directory rather than remembered.
 *
 * `route` is optional; when given it is verified to exist on disk first, so a
 * rename turns into a loud failure here instead of a 404 in the README.
 */
const SHOTS = [
  {
    name: "triage-queue",
    as: "doctor",
    url: "/dashboard/doctor/risk",
    file: "app/dashboard/doctor/risk/page.tsx",
    caption:
      "The clinician triage queue. Every row is a disclosure that reached a person. Acknowledging and resolving are separate acts, and the resolution records who did what.",
  },
  {
    name: "clinician-analytics",
    as: "doctor",
    url: "/dashboard/analytics",
    file: "app/dashboard/analytics/page.tsx",
    caption: "Clinician analytics.",
  },
  {
    name: "pre-session-briefing",
    as: "doctor",
    url: "/dashboard/briefing",
    file: "app/dashboard/briefing/page.tsx",
    caption: "The pre-session briefing: the record a clinician reads before the call.",
  },
  {
    name: "patient-dashboard",
    as: "patient",
    url: "/dashboard",
    file: "app/dashboard/page.tsx",
    caption: "The patient dashboard.",
  },
  {
    name: "mood-trend",
    as: "patient",
    url: "/dashboard/mood",
    file: "app/dashboard/mood/page.tsx",
    caption: "Fourteen days of seeded mood history, with an explicit insufficient-data state rather than a confident verdict from two data points.",
  },
  {
    name: "journal",
    as: "patient",
    url: "/dashboard/journal",
    file: "app/dashboard/journal/page.tsx",
    caption: "The patient's own private record.",
  },
  {
    name: "safety-plan",
    as: "patient",
    url: "/dashboard/safety-plan",
    file: "app/dashboard/safety-plan/page.tsx",
    caption:
      "The safety plan is written by the patient. It is never generated by a model, and a failed load renders an error rather than an empty form that saves as a blank.",
  },
  {
    name: "clinician-directory",
    as: "patient",
    url: "/doctors",
    file: "app/doctors/page.tsx",
    caption:
      "The clinician directory. Availability is the clinician's own statement, and its absence is labelled as such rather than filled in with a default.",
  },
  {
    name: "appointments",
    as: "patient",
    url: "/appointments",
    file: "app/appointments/page.tsx",
    caption: "Booked appointments, with follow-up scheduling and `.ics` export.",
  },
  {
    name: "messages",
    as: "patient",
    url: "/messages",
    file: "app/messages/page.tsx",
    caption:
      "Messaging. A crisis phrase in a patient-to-clinician message raises an alert for a human; there is no code path from a message to an external service.",
  },
  {
    name: "admin-console",
    as: "admin",
    url: "/dashboard/admin",
    file: "app/dashboard/admin/page.tsx",
    caption: "The admin console.",
  },
  {
    name: "admin-assessments",
    as: "admin",
    url: "/dashboard/assessments",
    file: "app/dashboard/assessments/page.tsx",
    caption: "Assessment review.",
  },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // Every route is verified against `client/app/` before the browser starts. A
  // renamed or deleted page is a loud failure here, not a 404 written into a
  // caption file.
  const missingRoutes = [];
  for (const s of SHOTS) {
    if (!s.file) continue;
    if (!fs.existsSync(path.join(__dirname, "..", s.file))) missingRoutes.push(`${s.name}: ${s.file}`);
  }
  if (missingRoutes.length) {
    console.error("these screenshot routes do not exist in client/app/:");
    for (const m of missingRoutes) console.error(`  ${m}`);
    process.exit(1);
  }

  const browser = await chromium.launch();
  const captured = [];
  const skipped = [];

  // Group by role. One context per role rather than one per shot: a context
  // carries cookies, and reusing the doctor session for the patient shots made
  // the role guard redirect every request back to /login, which is what the
  // second and third role runs looked like in the first version of this.
  const byRole = new Map();
  for (const s of SHOTS) {
    if (!byRole.has(s.as)) byRole.set(s.as, []);
    byRole.get(s.as).push(s);
  }

  for (const [role, shots] of byRole) {
    console.log(`\n${role}:`);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    await prepareContext(context);

    try {
      await login(page, ACCOUNTS[role]);
    } catch (e) {
      console.error(`  could not sign in as ${role}: ${e.message}`);
      for (const s of shots) skipped.push([s.name, "login failed"]);
      await context.close();
      continue;
    }

    for (const s of shots) {
      try {
        const res = await page.goto(`${WEB}${s.url}`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
        // A route that redirects to the sign-in page has silently failed.
        if (new URL(page.url()).pathname.startsWith("/login")) {
          throw new Error("redirected to /login - wrong role for this route?");
        }
        await shoot(page, s.name);
        captured.push(s);
      } catch (e) {
        console.error(`  skipped ${s.name}: ${e.message}`);
        skipped.push([s.name, e.message]);
      }
    }

    // The SOS control is page chrome rather than a route, so it is captured from
    // wherever that role happens to be.
    try {
      const sos = page.getByRole("button", { name: /sos|emergency|krisis|darurat/i }).first();
      if (await sos.count()) {
        await sos.click({ timeout: 8_000 });
        await settle(page, 900);
        await stripOverlays(page);
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(OUT, "sos-modal.png") });
        console.log("  captured sos-modal.png");
        captured.push({
          name: "sos-modal",
          caption:
            "The SOS control and its hotline list. Pressing it writes a durable alert and pages a named clinician; the UI reports what was actually delivered rather than assuming success.",
        });
      }
    } catch (e) {
      console.error(`  skipped sos-modal: ${e.message}`);
      skipped.push(["sos-modal", e.message]);
    }

    await context.close();
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