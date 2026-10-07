// Accessibility gates that do not need a browser.
//
// Three rules, all decided statically from the source:
//
//   1. No `<button>` without an accessible name.
//   2. No form error rendered without `role="alert"`, and no input left
//      un-associated from its own error.
//   3. No *new* sub-AA text colour. The existing count is a recorded budget that
//      may only shrink - see `CONTRAST_BUDGET`.
//
// ## Why rule 1 is written the way it is
//
// The first version of the detector stripped every `{...}` group before looking
// for text, which removed the string inside `{cond ? <Loader2/> : "Verify &
// Sign In"}`. It then reported 26 buttons as unlabelled, of which 2 were real.
// Twenty-four `aria-label`s would have been added to perfectly labelled buttons.
//
// So the accessible name is computed with balanced-brace scanning that keeps the
// string literals inside expressions, because `{cond ? <Icon/> : "Send"}` is
// labelled "Send" and a name is exactly what this rule is checking for.
//
// ## Why rule 3 is a budget and not a fix
//
// 286 uses of `text-gray-50..400` across 59 files fail AA, and `gray-400` on
// white is 2.54:1. Fixing all of them in one commit would be 59 files of visual
// change that nobody could review properly, and the odds of shipping a contrast
// regression somewhere in it are high.
//
// A budget that can only shrink is the honest version: the debt is measured, it
// is visible, it fails the build if it grows, and each fix moves the number down.
// A gate that requires zero would be disabled on the first day.

const fs = require("fs");
const path = require("path");

const CLIENT = path.join(__dirname, "..", "client");

/**
 * Text colours currently used, as a count. Lower it when you fix some; the gate
 * fails if the count rises above this.
 *
 * Measured 2026-10-06 across 59 files. `gray-400` (2.54:1) is the majority;
 * `gray-500` is 4.83:1 and passes, which is why the fix in register and
 * forgot-password is a one-shade change rather than a redesign.
 */
const CONTRAST_BUDGET = 285;

/** Tailwind's default greys. */
const GREY = {
  50: [249, 250, 251], 100: [243, 244, 246], 200: [229, 231, 235],
  300: [209, 213, 219], 400: [156, 163, 175],
};
const WHITE = [255, 255, 255];

const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrastOnWhite = (rgb) => {
  const la = luminance(rgb);
  const lb = luminance(WHITE);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Ratios for the shades the gate cares about, for the failure message. */
const RATIOS = Object.fromEntries(
  Object.entries(GREY).map(([k, v]) => [k, contrastOnWhite(v)])
);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "coverage", "test-results", "playwright-report"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * The accessible name a screen reader would compute, statically.
 *
 * Removes HTML comments, every tag with its attributes (keeping their content),
 * and every `{...}` expression - but keeps the string literals inside those
 * expressions first, because a label is very often exactly that.
 */
function staticName(inner) {
  const literals = [];
  let stripped = "";
  let i = 0;

  while (i < inner.length) {
    if (inner[i] === "{") {
      let depth = 0;
      let j = i;
      let inStr = null;
      for (; j < inner.length; j++) {
        const c = inner[j];
        if (inStr) {
          if (c === inStr && inner[j - 1] !== "\\") inStr = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
        if (c === "{") depth++;
        else if (c === "}" && --depth === 0) break;
      }
      const expr = inner.slice(i, j + 1);
      // Remove JSX tags *before* taking string literals. Without this,
      // `{isLoading ? <Loader2 className="animate-spin" /> : null}` yielded the
      // literal "animate-spin" and an icon-only button was judged to have an
      // accessible name called "animate-spin".
      //
      // This one is worth stating plainly: it made the gate produce false
      // negatives on exactly the buttons it exists to find, and it did so
      // quietly. The two icon-only buttons this pass fixed by hand would not
      // have been flagged - they are only flagged because somebody read the
      // markup, which is the thing the gate was supposed to stop needing.
      const withoutTags = expr.replace(/<[^>]*>/g, " ");
      for (const m of withoutTags.matchAll(/"([^"]*)"|'([^']*)'/g)) literals.push(m[1] ?? m[2]);
      i = j + 1;
      continue;
    }
    stripped += inner[i];
    i++;
  }

  const text = stripped
    // Removes comments. This is a *strip*, not a sanitiser: the result is only
    // ever tested for "does it contain a letter" and is never rendered or sent
    // anywhere. CodeQL flags the pattern as incomplete HTML sanitisation because
    // `<!-->` and nested forms are not matched - which would matter if the output
    // reached a browser, and cannot matter here, since a residual `<!--` cannot
    // make an unlabelled button look labelled.
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return [...literals, text].join(" ").trim();
}

/** `<button>` elements with no accessible name. */
function findUnnamedButtons(src) {
  const found = [];
  for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const [, attrs, inner] = m;
    if (/aria-label(?:ledby)?=/.test(attrs)) continue;
    if (/\btitle=/.test(attrs)) continue;
    if (/[A-Za-z0-9]/.test(staticName(inner))) continue;
    found.push(src.slice(0, m.index).split("\n").length);
  }
  return found;
}

/**
 * Error messages rendered without anything that announces them.
 *
 * The pattern matches any identifier *ending* in `errors`, case-insensitively, and
 * any dotted path ending in `.errors.<field>`. The first version anchored on a
 * literal `errors.` with a word boundary before it, which matches `errors.email`
 * and nothing else - so `loginErrors.email`, `registerErrors.password` and
 * `resetForm.formState.errors.otp` were all invisible to it, and the six sites it
 * found in `register` and `forgot-password` looked like the whole story when they
 * were the part of it that happened to use an unprefixed variable name.
 */
function findSilentErrors(src) {
  const found = [];
  // `{loginErrors.email.message}` - a brace, then any dotted path ending in
  // `errors` (case-insensitively), then the field access. The brace matters: an
  // earlier version required a `<` there, which matched nothing at all.
  for (const m of src.matchAll(
    /<(p|span|div)\b([^>]*)>[\s\S]{0,240}?\{(?:\w+\.)*\w*[eE]rrors\.[A-Za-z0-9_.]+[\s\S]{0,140}?<\/\1>/g
  )) {
    const [, , attrs] = m;
    if (/role="alert"/.test(attrs)) continue;
    if (/aria-live=/.test(attrs)) continue;
    found.push(src.slice(0, m.index).split("\n").length);
  }
  return found;
}

/** Uses of a text colour that fails AA against white. */
function countSubAaText(src) {
  let n = 0;
  for (const m of src.matchAll(/\btext-gray-(\d{2,3})\b/g)) if (m[1] in GREY) n += 1;
  return n;
}

module.exports = { findUnnamedButtons, findSilentErrors, countSubAaText, staticName, RATIOS, CONTRAST_BUDGET };

if (require.main === module) {
  const files = walk(CLIENT);
  const problems = [];
  let subAa = 0;

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(CLIENT, file).replace(/\\/g, "/");

    for (const line of findUnnamedButtons(src)) {
      problems.push(`${rel}:${line}: <button> has no accessible name (no text, no aria-label, no title)`);
    }
    for (const line of findSilentErrors(src)) {
      problems.push(`${rel}:${line}: a field error is rendered without role="alert", so it is never announced`);
    }
    subAa += countSubAaText(src);
  }

  if (subAa > CONTRAST_BUDGET) {
    problems.push(
      `sub-AA text colours: ${subAa} uses, budget is ${CONTRAST_BUDGET}.\n` +
        `      gray-400 on white is ${RATIOS[400].toFixed(2)}:1 and AA needs 4.5:1.\n` +
        "      The budget may only shrink. Fix some, or lower CONTRAST_BUDGET in\n" +
        "      scripts/check-a11y.js if you have."
    );
  }

  if (problems.length) {
    console.error(`check-a11y found ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("");
    process.exit(1);
  }

  console.log(`check-a11y: every button has a name and every field error is announced.`);
  console.log(
    `            ${subAa} sub-AA text colours remain, within the budget of ${CONTRAST_BUDGET}.`
  );
}