/**
 * Catch migration statements that only work on a case-insensitive filesystem.
 *
 * ## Why this exists
 *
 * `20260901000000_wave0_auth_hardening` contained:
 *
 *     DELETE `moodEntry` FROM `MoodEntry` JOIN ...
 *
 * In a multi-table DELETE the leading identifier is a *table reference*, not an
 * alias, so it is resolved under the server's `lower_case_table_names` setting:
 *
 *     - Windows and macOS MySQL: 1 (case-insensitive) -> the typo is invisible.
 *     - Linux:                     0 (case-sensitive)   -> `Unknown table`.
 *
 * Docker, Railway and the CI service container are all Linux, so this passed
 * every local run and would have failed the first deploy. It did fail CI, which
 * is the only reason it was found before production.
 *
 * The failure mode is nasty in a different way too: `migrate deploy` applies
 * migrations one at a time and records progress, so a failure in the middle of
 * the chain leaves the database in a state where the remaining migrations
 * "cannot be applied before the error is recovered from".
 *
 * ## What is checked
 *
 * Every backtick-quoted identifier that appears in a table position is compared
 * case-insensitively against the set of table names that earlier migrations
 * actually created. A reference whose case matches no known table is reported,
 * because on Linux it cannot resolve.
 *
 * Deliberately conservative: it only reports, never rewrites, and it only looks
 * at identifiers immediately followed by table-ish keywords. A false positive
 * costs a comment; a false negative costs a broken migration.
 */
const fs = require("fs");
const path = require("path");

const MIGRATIONS = path.resolve(__dirname, "../prisma/migrations");

// Statements that put an identifier in a table position. The identifier we care
// about is the first one after one of these.
const TABLE_POSITIONS = [
    /\bFROM\s+(`[^`]+`)/gi,
    /\bJOIN\s+(`[^`]+`)/gi,
    /\bINTO\s+(`[^`]+`)/gi,
    /\bUPDATE\s+(`[^`]+`)/gi,
    /\bTABLE\s+(`[^`]+`)/gi,
    /\bDELETE\s+(`[^`]+`)\s+FROM\b/gi,
];

/** Tables Prisma's own migration for this schema is expected to have created. */
const declared = new Map(); // lowercased -> Set of actual spellings

const migrationDirs = fs
    .readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.includes("_"))
    .map((e) => e.name)
    .sort();

const findings = [];

for (const dir of migrationDirs) {
    const file = path.join(MIGRATIONS, dir, "migration.sql");
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, "utf8");

    // Record every table this migration creates.
    for (const m of sql.matchAll(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`/gi
    )) {
        const key = m[1].toLowerCase();
        if (!declared.has(key)) declared.set(key, new Set());
        declared.get(key).add(m[1]);
    }

    // ...and check every table-position reference against what exists by now.
    for (const re of TABLE_POSITIONS) {
        for (const m of sql.matchAll(re)) {
            const name = m[1].slice(1, -1); // strip backticks
            const key = name.toLowerCase();
            if (!declared.has(key)) continue; // may be created later; not our concern
            const spellings = declared.get(key);
            if (!spellings.has(name)) {
                findings.push({
                    file: `${dir}/migration.sql`,
                    used: name,
                    createdAs: [...spellings].join(", "),
                });
            }
        }
    }
}

if (findings.length) {
    console.error("\n  Case-mismatched table references in migrations:\n");
    for (const f of findings) {
        console.error(`    ${f.file}`);
        console.error(`      references \`${f.used}\` but the table is created as \`${f.createdAs}\``);
    }
    console.error(
        "\n  These resolve on a case-insensitive filesystem (Windows, macOS) and" +
            "\n  fail on Linux with `Unknown table`. Docker, Railway and CI are Linux.\n"
    );
    process.exit(1);
}

console.log(
    `  migration table-case check passed: ${migrationDirs.length} migrations, ` +
        `${declared.size} tables`
);