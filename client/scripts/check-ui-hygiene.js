/**
 * The UI-hygiene ratchet.
 *
 * Two things this codebase was slowly losing ground on, plus one cheap
 * accessibility check:
 *
 *   - English text in JSX that `useTranslations` was meant to cover, so the
 *     Indonesian build silently falls back to English
 *   - `toLocaleDateString()` and friends, which render in the *viewer's* locale
 *     and timezone rather than the one the user chose; `lib/format.ts` exists to
 *     centralise exactly this
 *   - `<img>` without `alt`, which a screen reader announces as the file path
 *
 * It used to print counts and never fail, because a gate with 200 existing
 * violations blocks every pull request on debt nobody has started paying. The
 * budgets below are where the counts stood when this became a gate. They are
 * **maxima**: the count may go down, never up. Lower a budget when a migration
 * actually lands; raising one is a decision that should be argued for in the
 * change that does it.
 *
 * The floors are the other half. A broken walker reports zero and would sail
 * under any maximum, so a collapse that large fails too and asks whether the
 * instrument broke or the debt was genuinely paid.
 *
 * Run: node scripts/check-ui-hygiene.js
 * List: UI_HYGIENE_VERBOSE=1 node scripts/check-ui-hygiene.js
 */
const fs = require("fs");
const path = require("path");

const ROOTS = ["app", "components", "hooks", "lib"];
const FILES = /\.(tsx|ts)$/;
const TEST_FILES = /\.test\.tsx?$/;

/** Maxima. These may only go down. */
const BUDGET = { hardcoded: 184, bypasses: 38, imagesMissingAlt: 0 };

/** Floors. These guard the instrument, not the debt. Lower deliberately. */
const FLOOR = { hardcoded: 150 };

/** i18n message catalogues, used to tell a real string from an identifier. */
const MESSAGES = ["messages/en.json", "messages/id.json"].map((f) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", f), "utf8"))
);

const walk = (dir, out = []) => {
    const full = path.resolve(__dirname, "..", dir);
    if (!fs.existsSync(full)) return out;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        const p = path.join(full, entry.name);
        if (entry.isDirectory()) walk(path.join(dir, entry.name), out);
        else if (FILES.test(entry.name) && !TEST_FILES.test(entry.name)) out.push(p);
    }
    return out;
};

/** Every English catalogue value, lowercased, for the "is this translatable" test. */
const knownStrings = new Set();
const collect = (obj) => {
    for (const v of Object.values(obj)) {
        if (typeof v === "string") knownStrings.add(v.trim().toLowerCase());
        else if (v && typeof v === "object") collect(v);
    }
};
MESSAGES.forEach(collect);

const sources = ROOTS.flatMap((r) => walk(r));

// ---------------------------------------------------------------------------
// 1. Hardcoded UI text
// ---------------------------------------------------------------------------
// Visible text nodes and the common visible-string props. Deliberately narrow:
// a false positive on `className` or a route string would be noise.
//
//   >Some words<                      visible text
//   placeholder="Search"             a visible attribute
//   title="Close menu"               ditto, and an accessibility label
//   aria-label="Open navigation"     ditto
//   alt="Doctor"                     ditto
const TEXT_NODE = />([A-Z][^<>{}\n]{3,})</g;
const STRING_PROP =
    /\b(placeholder|title|aria-label|alt|label|aria-placeholder)\s*=\s*"([^"]{3,})"/g;

const hardcoded = [];
for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(path.resolve(__dirname, ".."), file).replace(/\\/g, "/");

    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
        // Skip comment lines: prose in a comment is not UI text.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"))
            return;

        for (const m of line.matchAll(TEXT_NODE)) {
            const value = m[1].trim();
            // Already in the catalogue, or not prose.
            if (knownStrings.has(value.toLowerCase())) continue;
            if (!/\s/.test(value)) continue;
            hardcoded.push({ rel, line: i + 1, value });
        }
        for (const m of line.matchAll(STRING_PROP)) {
            const value = m[2].trim();
            if (knownStrings.has(value.toLowerCase())) continue;
            hardcoded.push({ rel, line: i + 1, value });
        }
    });
}

// ---------------------------------------------------------------------------
// 2. Date/time formatting that bypasses lib/format.ts
// ---------------------------------------------------------------------------
// `toLocaleDateString()` and friends render in the *viewer's* locale and timezone,
// which silently disagrees with the locale the user actually chose. `lib/format.ts`
// exists to centralise exactly this.
const LOCALE_CALL =
    /\.(toLocaleDateString|toLocaleTimeString|toLocaleString)\s*\(/g;
const FORMAT_LIB = path.resolve(__dirname, "..", "lib", "format.ts");

const bypasses = [];
for (const file of sources) {
    if (path.resolve(file) === FORMAT_LIB) continue;
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(path.resolve(__dirname, ".."), file).replace(/\\/g, "/");
    text.split(/\r?\n/).forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        for (const _ of line.matchAll(LOCALE_CALL)) {
            bypasses.push({ rel, line: i + 1 });
        }
    });
}

// ---------------------------------------------------------------------------
// 3. Images without alt text
// ---------------------------------------------------------------------------
// Screen readers announce `alt=""` as decorative and skip it, but a *missing* alt
// makes them read the file path. Cheap to check, easy to regress.
//
// Matched against whole tags rather than lines: a multi-line `<img>` with its alt
// on the next line is the normal formatting here, and a line-based check reports
// every one of them as missing. The first version of this guard did exactly that
// and found six false positives out of seven, which is a good way to get a guard
// ignored.
const IMG_TAG = /<img\b[^>]*>/g;
const imagesMissingAlt = [];
for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path
        .relative(path.resolve(__dirname, ".."), file)
        .replace(/\\/g, "/");
    for (const m of text.matchAll(IMG_TAG)) {
        if (!/\balt\s*=/.test(m[0])) {
            imagesMissingAlt.push({
                rel,
                line: text.slice(0, m.index).split(/\r?\n/).length,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// 4. The ratchet itself
// ---------------------------------------------------------------------------

/**
 * Classifies the measured counts. Pure, so the self-test can pin both halves:
 * a count above its maximum fails, and the translatable-text counter collapsing
 * below its floor fails too (that is the walker breaking, not debt being paid).
 *
 * @returns {{ failures: string[], over: string[], under: string[] }}
 */
const judge = (counts, budget = BUDGET, floor = FLOOR) => {
    const rows = [
        ["hardcoded UI strings", counts.hardcoded, budget.hardcoded, floor.hardcoded],
        ["locale bypasses", counts.bypasses, budget.bypasses, undefined],
        ["<img> without alt", counts.imagesMissingAlt, budget.imagesMissingAlt, undefined],
    ];
    const failures = [];
    const over = [];
    const under = [];
    for (const [label, actual, max, min] of rows) {
        if (actual > max) {
            over.push(`${label}: ${actual}, budget ${max} (+${actual - max})`);
            failures.push(label);
        }
        if (min !== undefined && actual < min) {
            under.push(`${label}: ${actual}, floor ${min} - did the walker break?`);
            failures.push(label);
        }
    }
    return { failures, over, under };
};

module.exports = { judge, BUDGET, FLOOR };

if (require.main === module) {
    const counts = {
        hardcoded: hardcoded.length,
        bypasses: bypasses.length,
        imagesMissingAlt: imagesMissingAlt.length,
    };
    const filesWith = (rows) => new Set(rows.map((r) => r.rel)).size;

    console.log("  UI hygiene (budgets may only go down)\n");
    console.log(`    hardcoded UI strings     ${hardcoded.length} in ${filesWith(hardcoded)} files   (max ${BUDGET.hardcoded})`);
    console.log(`    locale bypasses          ${bypasses.length} in ${filesWith(bypasses)} files   (max ${BUDGET.bypasses})`);
    console.log(`    <img> without alt         ${imagesMissingAlt.length} in ${filesWith(imagesMissingAlt)} files   (max ${BUDGET.imagesMissingAlt})`);

    if (process.env.UI_HYGIENE_VERBOSE) {
        const show = (label, rows) => {
            if (!rows.length) return;
            console.log(`\n  ${label}:`);
            for (const r of rows) {
                console.log(`    ${r.rel}:${r.line}${r.value ? `  "${r.value}"` : ""}`);
            }
        };
        show("hardcoded UI strings", hardcoded);
        show("locale bypasses", bypasses);
        show("<img> without alt", imagesMissingAlt);
    }

    const { over, under } = judge(counts);
    if (over.length === 0 && under.length === 0) {
        console.log("\n  within budget (and the counters still find what they expect).");
    } else {
        for (const line of over) console.error(`\n  OVER BUDGET  ${line}`);
        for (const line of under) console.error(`\n  UNDER FLOOR  ${line}`);
        console.error(
            "\n  Lower a budget when a migration lands. Raising one is a decision, not a fix."
        );
        process.exitCode = 1;
    }
}
