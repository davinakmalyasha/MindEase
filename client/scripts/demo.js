// Portfolio demo recorder.
//
// Not a Playwright spec, for the same reason `screenshots.js` is not one: the
// documented test count should only include things that assert. This script
// records a short, repeatable tour of the seeded application and, when
// `FFMPEG` is set, converts it to `docs/screenshots/demo.gif`.
//
// Usage, against a seeded local stack (API :5000, web :3000):
//
//     FFMPEG=/path/to/ffmpeg node scripts/demo.js
//
// Set DEMO_WEB_URL if the app is not on http://localhost:3000. The video is
// written to a temporary directory first. Nothing is installed system-wide;
// `ffmpeg-static` in a temp folder is enough for the conversion.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("@playwright/test");

const WEB = process.env.DEMO_WEB_URL || "http://localhost:3000";
const NAV = Number(process.env.DEMO_TIMEOUT_MS || 120_000);
const OUT_DIR = path.join(__dirname, "..", "..", "docs", "screenshots");
const OUT = path.join(OUT_DIR, "demo.gif");
const RAW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mindease-demo-"));

const ACCOUNTS = {
  patient: { email: "patient@mindease.app", password: "Patient@123" },
  doctor: { email: "dr1@mindease.app", password: "Doctor@123" },
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cursor, caption and click ripple, installed into every document.
 *
 * A headless recording does not contain an operating-system cursor, so every
 * click would otherwise land invisibly. The cursor is a DOM element moved
 * before each interaction; the ripple makes the click itself legible.
 * Consent is pre-set rather than clicked: the panel re-mounts on client
 * navigation, which is the same race `screenshots.js` documents.
 */
const UI_SCRIPT = ([consentKey]) => {
  try {
    window.localStorage.setItem(consentKey, "declined");
  } catch {
    // Storage disabled; the strip below removes the panel instead.
  }

  window.__demoCaption = (text) => {
    window.__pendingCaption = text;
    const el = document.getElementById("mindease-demo-caption");
    if (!el) return;
    el.textContent = text;
    el.style.opacity = text ? "1" : "0";
  };

  window.__demoCursor = (x, y) => {
    const el = document.getElementById("mindease-demo-cursor");
    if (!el) return;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };

  const install = () => {
    if (!document.body) {
      setTimeout(install, 50);
      return;
    }
    if (!document.getElementById("mindease-demo-style")) {
      const style = document.createElement("style");
      style.id = "mindease-demo-style";
      style.textContent = `
        /* The verify-email banner and the Next dev error badge are rendered
           after hydration; hide them rather than removing nodes React owns. */
        div.bg-amber-50.border-amber-200,
        nextjs-portal { display: none !important; }
        #mindease-demo-caption {
          position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
          max-width: 78vw; padding: 10px 20px; border-radius: 999px;
          background: rgba(17, 24, 39, 0.84); color: #fff;
          font: 600 16px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
          letter-spacing: 0.01em; text-align: center; white-space: nowrap;
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
          z-index: 2147483646; pointer-events: none; opacity: 0;
          transition: opacity 0.25s ease; overflow: hidden; text-overflow: ellipsis;
        }
        #mindease-demo-cursor {
          position: fixed; left: -100px; top: -100px; width: 16px; height: 16px;
          border-radius: 50%; background: rgba(255, 255, 255, 0.95);
          border: 2px solid rgba(17, 24, 39, 0.85);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
          transform: translate(-50%, -50%);
          z-index: 2147483647; pointer-events: none;
          transition: left 0.18s ease, top 0.18s ease;
        }
        .mindease-demo-ripple {
          position: fixed; width: 16px; height: 16px; border-radius: 50%;
          border: 2px solid rgba(79, 70, 229, 0.75);
          background: rgba(79, 70, 229, 0.28);
          transform: translate(-50%, -50%);
          pointer-events: none; z-index: 2147483647;
          animation: mindease-demo-ripple 0.5s ease-out forwards;
        }
        @keyframes mindease-demo-ripple {
          from { opacity: 1; transform: translate(-50%, -50%) scale(0.6); }
          to { opacity: 0; transform: translate(-50%, -50%) scale(3.2); }
        }
      `;
      document.head.appendChild(style);
    }
    if (!document.getElementById("mindease-demo-caption")) {
      const caption = document.createElement("div");
      caption.id = "mindease-demo-caption";
      document.body.appendChild(caption);
      if (window.__pendingCaption) window.__demoCaption(window.__pendingCaption);
    }
    if (!document.getElementById("mindease-demo-cursor")) {
      const cursor = document.createElement("div");
      cursor.id = "mindease-demo-cursor";
      document.body.appendChild(cursor);
    }
    if (!window.__demoRippleBound) {
      window.__demoRippleBound = true;
      document.addEventListener(
        "mousedown",
        (event) => {
          const ripple = document.createElement("div");
          ripple.className = "mindease-demo-ripple";
          ripple.style.left = `${event.clientX}px`;
          ripple.style.top = `${event.clientY}px`;
          document.body.appendChild(ripple);
          setTimeout(() => ripple.remove(), 550);
        },
        true
      );
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
};

async function caption(page, text) {
  await page.waitForFunction(() => typeof window.__demoCaption === "function", { timeout: 5_000 }).catch(() => {});
  await page.evaluate((value) => window.__demoCaption(value), text).catch(() => {});
}

async function moveCursor(page, locator) {
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  const box = await locator.boundingBox();
  if (!box) return;
  await page
    .evaluate(([x, y]) => window.__demoCursor(x, y), [box.x + box.width / 2, box.y + box.height / 2])
    .catch(() => {});
  await wait(220);
}

async function click(page, locator) {
  await moveCursor(page, locator);
  await locator.click();
  await wait(350);
}

async function fill(page, locator, value) {
  await moveCursor(page, locator);
  await locator.fill(value);
  await wait(350);
}

/**
 * Remove the chrome that is not the page: the Next dev badge, consent panel,
 * notification prompt, and the "verify your email" banner. The screenshots
 * script uses the same text-first technique; the element carrying the text is
 * usually nested inside the fixed panel, so walk up to the positioned parent.
 */
async function stripOverlays(page) {
  await page
    .evaluate(() => {
      for (const el of document.querySelectorAll("nextjs-portal")) el.remove();
      const removeContaining = (needle) => {
        const all = [...document.querySelectorAll("body *")].filter((el) => (el.textContent || "").includes(needle));
        const innermost = all[all.length - 1];
        if (!innermost) return;
        const panel = innermost.closest('[class*="fixed"], [class*="absolute"]') || innermost;
        panel.remove();
      };
      removeContaining("Cookies & privacy");
      removeContaining("Enable notifications?");
    })
    .catch(() => {});
}

async function settle(page, ms = 1_200) {
  await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function goto(page, url, ms = 1_200) {
  await page.goto(`${WEB}${url}`, { waitUntil: "domcontentloaded", timeout: NAV });
  await settle(page, ms);
  await stripOverlays(page);
}

async function signIn(page, who, label) {
  await goto(page, "/login", 700);
  await page.getByLabel(/email/i).waitFor({ timeout: NAV });
  await caption(page, label);
  await wait(600);
  await fill(page, page.getByLabel(/email/i), who.email);
  await fill(page, page.getByLabel(/password/i), who.password);
  await click(page, page.getByRole("button", { name: /sign in/i }).first());
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: NAV });
  await settle(page, 1_400);
  await stripOverlays(page);
}

/** Opens the first date with a free time and stops on the review step. */
async function chooseFirstSlot(page) {
  const chips = page
    .locator("button:enabled")
    .filter({ hasText: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d{2}[A-Z][a-z]{2}$/ });
  const next = page.locator("button", { hasText: /Continue/ }).first();
  const back = page.getByRole("button", { name: /^Back$/ });
  const times = page.locator("button").filter({ hasText: /^\d{2}:\d{2}$/ });
  const empty = page.getByText("No open slots for this day");

  const days = await chips.count();
  for (let i = 0; i < days; i += 1) {
    const chip = chips.nth(i);
    await moveCursor(page, chip);
    try {
      await chip.click({ timeout: 3_000 });
    } catch {
      continue;
    }
    await wait(250);
    await click(page, next);

    // The step swap is animated; wait for step 2's content, not the progress marker.
    await times.first().or(empty).waitFor({ timeout: 8_000 });
    if ((await times.count()) === 0) {
      await click(page, back);
      continue;
    }

    await click(page, times.first());
    await click(page, next); // step 3: patient details

    const name = page.locator("#booking-name");
    await name.waitFor({ timeout: 8_000 });
    if (!(await name.inputValue()).trim()) {
      await fill(page, name, "Demo Patient");
    }
    await click(page, next); // step 4: review, deliberately not confirmed

    await page.getByRole("button", { name: /Confirm & schedule/i }).waitFor({ timeout: 5_000 });
    return;
  }
  throw new Error("no date in the picker offered an open slot");
}

async function outro(page) {
  await caption(page, "");
  await page.evaluate(() => document.getElementById("mindease-demo-cursor")?.remove());
  await page.evaluate(() => {
    const el = document.createElement("div");
    el.id = "mindease-demo-outro";
    el.innerHTML =
      '<div style="font:700 44px/1.1 ui-sans-serif,system-ui,sans-serif;letter-spacing:-0.03em">MindEase</div>' +
      '<div style="margin-top:14px;font:500 16px/1.4 ui-sans-serif,system-ui,sans-serif;color:#c7d2fe">Booking · Clinical records · Safety that reaches a person</div>';
    Object.assign(el.style, {
      position: "fixed",
      inset: "0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      background: "#0f172a",
      color: "#ffffff",
      textAlign: "center",
      zIndex: "2147483645",
      opacity: "0",
      transition: "opacity 0.5s ease",
      pointerEvents: "none",
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
    });
  });
  await wait(2_600);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: RAW_DIR, size: { width: 1280, height: 720 } },
  });
  await context.addInitScript(UI_SCRIPT, ["mindease-cookie-consent"]);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  console.log("demo: landing");
  await goto(page, "/", 1_800);
  await caption(page, "MindEase — therapy, records and clinical safety in one place");
  await wait(2_000);

  console.log("demo: patient sign-in");
  await signIn(page, ACCOUNTS.patient, "Signing in as the seeded patient");
  await page.getByText(/How are you feeling\?/).waitFor({ timeout: 20_000 });
  await wait(800);

  await caption(page, "Mood, appointments and AI resources for the week");
  await page.evaluate(() => window.scrollBy({ top: 240, behavior: "smooth" }));
  await wait(1_400);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await wait(900);

  console.log("demo: directory");
  await goto(page, "/doctors", 1_400);
  await page.getByText(/Showing \d+ of \d+ doctors/).waitFor({ timeout: 20_000 });
  await caption(page, "Find a clinician by specialty, price and real availability");
  await wait(900);
  const doctorCard = page.locator('a[href^="/doctors/"]').first();
  await doctorCard.waitFor({ timeout: 15_000 });
  await moveCursor(page, doctorCard);
  await wait(700);
  await click(page, doctorCard);
  await page.waitForURL(/\/doctors\/[^/]+$/, { timeout: NAV });
  await settle(page, 1_500);
  await stripOverlays(page);
  await page.getByRole("link", { name: /Book Consultation/i }).waitFor({ timeout: 20_000 });
  await caption(page, "A verified profile — availability labelled, never invented");
  await wait(1_600);

  console.log("demo: booking");
  const book = page.getByRole("link", { name: /Book Consultation/i }).first();
  await moveCursor(page, book);
  await wait(500);
  await click(page, book);
  await page.waitForURL(/\/appointments\?doctor=/, { timeout: NAV });
  await settle(page, 1_200);
  await stripOverlays(page);
  await page.getByText(/SELECT CONSULTATION DATE/i).waitFor({ timeout: 20_000 });
  await caption(page, "Choose a session time — the slot claim is atomic");
  await wait(1_000);
  await chooseFirstSlot(page);
  await caption(page, "The flow stops before confirming; no booking is written by this demo");
  await wait(1_800);

  console.log("demo: clinician queue");
  await page.evaluate(() => window.localStorage.clear());
  await context.clearCookies();
  await signIn(page, ACCOUNTS.doctor, "Now the clinician side");
  await goto(page, "/dashboard/doctor/risk", 1_800);
  await page.getByRole("button", { name: /Mark as seen/i }).first().waitFor({ timeout: 20_000 });
  await caption(page, "Every disclosure reaches a named clinician — and stays in the record");
  await wait(2_800);
  const markSeen = page.getByRole("button", { name: /Mark as seen/i }).first();
  if (await markSeen.count()) {
    await moveCursor(page, markSeen);
    await wait(1_100);
  }

  console.log("demo: outro");
  await outro(page);

  const video = page.video();
  await page.close();
  await context.close();
  const webm = await video.path();
  await browser.close();
  console.log(`demo: recorded ${webm}`);

  if (process.env.FFMPEG) {
    const ffmpeg = process.env.FFMPEG;
    const palette = path.join(RAW_DIR, "palette.png");
    const scale = "scale=760:-1:flags=lanczos";
    console.log("demo: building the GIF palette");
    execFileSync(
      ffmpeg,
      ["-y", "-i", webm, "-vf", `setpts=0.8*PTS,fps=8,${scale},palettegen=max_colors=128:stats_mode=diff`, palette],
      { stdio: "inherit" }
    );
    console.log("demo: encoding the GIF");
    execFileSync(
      ffmpeg,
      [
        "-y",
        "-i",
        webm,
        "-i",
        palette,
        "-filter_complex",
        `setpts=0.8*PTS,fps=8,${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
        "-loop",
        "0",
        OUT,
      ],
      { stdio: "inherit" }
    );
    const size = fs.statSync(OUT).size;
    console.log(`demo: wrote ${OUT} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    if (size > 9 * 1024 * 1024) {
      console.warn("demo: the GIF is above 9 MB; reduce fps or width before committing");
    }
  } else {
    console.log("demo: set FFMPEG=/path/to/ffmpeg to convert the recording to docs/screenshots/demo.gif");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
