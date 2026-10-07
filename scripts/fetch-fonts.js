#!/usr/bin/env node
// Re-downloads the self-hosted font(s) in `client/app/fonts/`.
//
// This script is referenced by `client/app/fonts/README.md` and by a comment in
// `client/app/layout.tsx`. It had never existed in this repository: the upgrade
// instructions said "change the ranges in `scripts/fetch-fonts.js`, re-run it,
// and commit the new files", which is not something anyone can do. That is worth
// writing out plainly rather than deleting the instruction, because a pinned
// webfont with no way to refresh it will quietly rot.
//
//     node scripts/fetch-fonts.js
//
// Exits non-zero without writing anything if the network is unavailable, so a
// failed upgrade cannot leave a truncated font in the tree - which is the failure
// mode that would be worst here, because the build would still succeed and every
// page would render in a fallback.

const fs = require("fs");
const path = require("path");
const https = require("https");

const FONT_DIR = path.join(__dirname, "..", "client", "app", "fonts");

/**
 * What to fetch.
 *
 * `css2` is Google's variable-font endpoint. The axis range is expressed as a
 * two-value form (`wght@200..800`), which is what requests the variable font
 * rather than a set of static weights - and a static set would mean either a
 * dozen files or a synthesised weight.
 */
const FONTS = [
  {
    family: "Plus Jakarta Sans",
    // The layout omits `weight`, so the whole axis is requested.
    spec: "family=Plus+Jakarta+Sans:wght@200..800",
    file: "PlusJakartaSans-Variable.woff2",
    label: "Plus Jakarta Sans",
  },
];

// A desktop browser UA. Google Fonts serves `woff2` to browsers and older formats
// to anything that looks like a script, so a request without this produces a file
// named `.woff2` that is not a WOFF2.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36";

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": UA, ...headers } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(get(res.headers.location, headers));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`${url} -> HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

/** Every `url(...)` in a Google Fonts stylesheet that is a woff2. */
function woff2Urls(css) {
  const urls = [];
  const re = /url\((https:\/\/[^)]+\.woff2)\)/g;
  let m;
  while ((m = re.exec(css)) !== null) urls.push(m[1]);
  return urls;
}

/** `"latin"` and friends: the comment that precedes each @font-face block. */
function subsets(css) {
  const found = [];
  const re = /\/\*\s*([a-z-]+)\s*\*\/\s*@font-face/g;
  let m;
  while ((m = re.exec(css)) !== null) found.push(m[1]);
  return found;
}

async function fetchFont(font) {
  const cssUrl = `https://fonts.googleapis.com/css2?${font.spec}&display=swap`;
  const css = (await get(cssUrl)).toString("utf8");
  const urls = woff2Urls(css);

  if (!urls.length) {
    throw new Error(
      `no woff2 URL in the stylesheet for ${font.label}. Google may have changed ` +
        "the response, or the axis range may be wrong."
    );
  }

  const subsetsSeen = subsets(css);
  // Google emits one @font-face per unicode-range subset, in a fixed order, with
  // `latin` last. The latin subset is the one this project needs; committing the
  // others would multiply the size of the repository for glyphs the UI never
  // renders.
  const latinIndex = subsetsSeen.lastIndexOf("latin");
  if (latinIndex === -1) {
    throw new Error(
      `could not find the latin subset for ${font.label}. Subsets seen: ${subsetsSeen.join(", ")}`
    );
  }

  const url = urls[latinIndex];
  const body = await get(url);

  // Four bytes, "wOF2". A file that is not this is a subset in another format
  // that happens to have been named .woff2, and it fails at build time in a way
  // that does not say so.
  const magic = body.subarray(0, 4).toString("latin1");
  if (magic !== "wOF2") {
    throw new Error(
      `${font.file}: the download starts with ${JSON.stringify(magic)}, not "wOF2". ` +
        "Google served a different format - check the User-Agent."
    );
  }

  const target = path.join(FONT_DIR, font.file);
  const previous = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const unchanged = previous && Buffer.compare(previous, body) === 0;

  if (unchanged) {
    console.log(`  ${font.file}: unchanged (${body.length} bytes)`);
    return;
  }

  // Write to a temporary name and rename into place. A rename on the same
  // filesystem is atomic, so an interrupted run can never leave a partial font
  // under the real name.
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);

  const delta = previous ? ` (was ${previous.length})` : "";
  console.log(`  ${font.file}: ${body.length} bytes${delta}`);
}

async function main() {
  fs.mkdirSync(FONT_DIR, { recursive: true });

  for (const font of FONTS) {
    await fetchFont(font);
  }

  console.log("\nDone. Review with `git diff --stat client/app/fonts` and commit.");
}

main().catch((e) => {
  console.error(`fetch-fonts failed: ${e.message}`);
  console.error("Nothing was written. The committed fonts are untouched.");
  process.exit(1);
});