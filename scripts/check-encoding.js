#!/usr/bin/env node
/**
 * Guards against character-encoding corruption in source copy.
 *
 * Two failure modes have occurred in this repository:
 *
 *   1. **Reversible mojibake** — UTF-8 bytes decoded as Windows-1252, leaving
 *      the classic three-character sequences for a dash or a curly quote.
 *      Recoverable by re-encoding, but it means some tool in the pipeline
 *      mangled the text.
 *   2. **Lossy mojibake** — the same corruption after a lossy decode, leaving
 *      U+FFFD replacement characters or a bare `?` standing in for a glyph.
 *      Not recoverable; the intended character has to be restored by hand.
 *
 * Both surface as visible damage in a mental-health product: mangled email
 * subject lines, broken price-filter labels, gibberish in a patient's mood
 * dashboard. This check makes it a build failure rather than a support ticket.
 *
 * Exits non-zero when anything is found, so CI can gate on it.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const TEXT_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml",
    ".prisma", ".css", ".go", ".sql", ".sh", ".ps1", ".txt", ".html",
]);

const SKIP_DIRECTORIES = new Set([
    "node_modules", ".next", "dist", "build", ".git", "coverage",
    "test-results", "playwright-report", "uploads", "backups",
]);

// U+FFFD: a character that could not be decoded.
const REPLACEMENT = /\uFFFD/;
// A question mark immediately after typographic punctuation is the fingerprint
// of a glyph that was lost and only its question mark survived.
const LOST_GLYPH = /[\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u2020]\?/;
// Reversible mojibake: a cp1252-mangled lead byte followed by its trail byte.
const CP1252 = /[\u00C2\u00E2\u00E3][\u0080-\u00BF\u20AC\u201A\u0192\u201E\u2026\u2020\u2018\u2019\u201C\u201D\u2013\u2014\u2022]/;

const findings = [];

const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full);
            continue;
        }
        if (!TEXT_EXTENSIONS.has(path.extname(entry.name))) continue;

        let contents;
        try {
            const bytes = fs.readFileSync(full);
            // A NUL byte in the first block means this is not really text.
            if (bytes.subarray(0, 512).includes(0)) continue;
            contents = bytes.toString("utf8");
        } catch {
            continue;
        }

        contents.split("\n").forEach((line, index) => {
            const kind = REPLACEMENT.test(line)
                ? "lossy"
                : CP1252.test(line)
                  ? "mojibake"
                  : LOST_GLYPH.test(line)
                    ? "lost-glyph"
                    : null;
            if (kind) {
                findings.push({
                    file: path.relative(ROOT, full),
                    line: index + 1,
                    kind,
                    text: line.trim().slice(0, 120),
                });
            }
        });
    }
};

walk(ROOT);

if (findings.length === 0) {
    console.log("encoding check passed: no corrupted characters found");
    process.exit(0);
}

console.error(`encoding check FAILED: ${findings.length} corrupted line(s)\n`);
for (const f of findings) {
    console.error(`  [${f.kind}] ${f.file}:${f.line}`);
    console.error(`      ${f.text}`);
}
console.error(
    "\nFix: replace the corrupted character with the intended one. " +
        "If the surrounding text does not make the intent obvious, " +
        "recover it from git history before editing."
);
process.exit(1);
