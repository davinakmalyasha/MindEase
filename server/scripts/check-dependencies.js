/**
 * Reports whether each declared dependency is actually referenced.
 *
 * An unused dependency is not only bytes: it is unreviewed third-party code in
 * the runtime path, and for a platform holding mental-health data every
 * unnecessary package widens the supply-chain surface.
 *
 * ## What counts as "referenced"
 *
 * The whole package is walked, minus build output and installed packages - not
 * a hand-listed set of source directories. The previous list omitted
 * `eslint.config.mjs`, so it reported `@eslint/js` and `typescript-eslint` as
 * unused, and it missed root config files other than `prisma.config.ts`. A
 * guard that fails on its own blind spots teaches people to ignore it, which is
 * how this one stayed advisory.
 *
 * Two things are legitimately used without an `import`, and both are handled by
 * rule rather than by an allowlist entry that would hide the next instance:
 *
 *   - a coverage provider selected *by name* in a config -
 *     `coverage: { provider: "v8" }` resolves `@vitest/coverage-v8`. See
 *     `CONFIGURED`.
 *   - the MySQL driver Prisma's engine loads at runtime and the toolchain
 *     packages npm scripts invoke. See `INDIRECT`, one reason per entry.
 *
 * `@types/*` packages are exempt: they are consumed by the TypeScript compiler
 * and by editors, never imported.
 *
 * Exit code is 1 when anything is unused, so this can gate. `--write` strips
 * them from `package.json` (and exits 1, because the lockfile then needs
 * regenerating).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const SKIP = new Set([
    "node_modules", ".next", "dist", ".git", "test-results", "coverage", "playwright-report",
    "uploads", ".playwright-mcp",
]);

const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

/** Every scannable file under `root`, as texts. */
const collectCorpus = (root) => {
    const texts = [];
    const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (EXTENSIONS.has(path.extname(entry.name))) {
                texts.push(fs.readFileSync(full, "utf8"));
            }
        }
    };
    walk(root);
    return texts;
};

/** Matches a bare or subpath import/require of `name`. */
const isImported = (name, corpus) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:from\\s*|require\\(\\s*|import\\(\\s*)["']${escaped}(?:/[^"']*)?["']`);
    return corpus.some((text) => re.test(text));
};

/**
 * Packages selected by configuration value rather than imported.
 *
 * A convention rather than a package name: the next coverage provider is
 * matched without touching this file.
 */
const CONFIGURED = [
    (name, corpus) => {
        const match = /^@vitest\/coverage-(.+)$/.exec(name);
        return (
            Boolean(match) &&
            corpus.some((text) => new RegExp(`provider\\s*:\\s*["']${match[1]}["']`).test(text))
        );
    },
];

const isConfiguredUse = (name, corpus) => CONFIGURED.some((rule) => rule(name, corpus));

/**
 * Packages required without being imported.
 *
 * `mysql2` is the MySQL driver Prisma's engine loads at runtime, and the
 * toolchain packages are invoked from `package.json` scripts or `npx` rather
 * than imported.
 */
const INDIRECT = new Set([
    "mysql2", // Prisma MySQL engine driver
    "prisma", // CLI: `npx prisma migrate|generate`
    "typescript", // `tsc --noEmit`
    "ts-node", // `npm start`, `db:seed`
    "nodemon", // `npm run dev`
    "cross-env", // `npm run test:db`
]);

/** @returns {{ section: string, name: string }[]} */
const findUnused = (pkg, corpus) => {
    const scriptText = Object.values(pkg.scripts || {}).join("\n");
    const unused = [];
    for (const section of ["dependencies", "devDependencies"]) {
        for (const name of Object.keys(pkg[section] || {})) {
            if (name.startsWith("@types/")) continue;
            if (INDIRECT.has(name) || scriptText.includes(name)) continue;
            if (isImported(name, corpus) || isConfiguredUse(name, corpus)) continue;
            unused.push({ section, name });
        }
    }
    return unused;
};

module.exports = { findUnused, isImported, isConfiguredUse, collectCorpus };

if (require.main === module) {
    const pkgPath = path.join(ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const unused = findUnused(pkg, collectCorpus(ROOT));

    if (unused.length > 0) {
        console.log("Unused dependencies:\n");
        for (const { section, name } of unused) {
            console.log(`  ${section.padEnd(15)} ${name}`);
        }
        console.log("\nRemove them, or reference them, or add a reason to INDIRECT.");
    } else {
        console.log("dependency check passed: every declared package is referenced");
    }

    if (process.argv.includes("--write") && unused.length > 0) {
        for (const { section, name } of unused) {
            delete pkg[section][name];
            console.log(`removed ${name} from ${section}`);
        }
        fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
        console.log("package-lock.json is now stale - run npm install.");
    }

    process.exitCode = unused.length > 0 ? 1 : 0;
}
