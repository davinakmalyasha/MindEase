const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SKIP = new Set([
    "node_modules", ".next", ".git", "test-results", "coverage", "playwright-report", "dist", "backups",
]);
const EXT = /\.(ts|tsx|js|mjs)$/;

const findings = [];

/**
 * Looks for typographic punctuation that has landed in a code position — the
 * fingerprint of a bulk text repair that also rewrote a JavaScript operator.
 * A dash inside a string literal is fine; a dash sitting between two
 * expressions is not.
 */
const CODE_POSITION = /[)\]\w'"`] ?[\u2014\u2013] ?[\w([{]/;

(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full);
            continue;
        }
        if (!EXT.test(entry.name)) continue;

        const text = fs.readFileSync(full, "utf8");
        text.split("\n").forEach((line, i) => {
            if (!/[\u2014\u2013]/.test(line)) return;
            // Strip string literals, then look for a dash still in the code.
            const withoutStrings = line
                .replace(/"(?:[^"\\]|\\.)*"/g, '""')
                .replace(/'(?:[^'\\]|\\.)*'/g, "''")
                .replace(/`(?:[^`\\]|\\.)*`/g, "``")
                .replace(/\/\/.*$/, "");
            if (/[\u2014\u2013]/.test(withoutStrings)) {
                findings.push(
                    `${path.relative(ROOT, full)}:${i + 1}  ${line.trim().slice(0, 120)}`
                );
            }
        });
    }
})(ROOT);

if (findings.length === 0) {
    console.log("operator check passed: no typographic dashes in code positions");
} else {
    console.log(`Suspicious: typographic punctuation in ${findings.length} code position(s)\n`);
    findings.forEach((f) => console.log("  " + f));
    process.exitCode = 1;
}
