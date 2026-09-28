/**
 * Reports whether each declared dependency is actually imported.
 *
 * An unused dependency is not only bytes: it is unreviewed third-party code
 * in the runtime path, and for a platform holding mental-health data every
 * unnecessary package widens the supply-chain surface.
 *
 * Run with `--write` to strip the unused ones from `package.json`.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SKIP = new Set([
    "node_modules", ".next", "dist", ".git", "test-results", "coverage", "playwright-report",
]);

const walk = (dir, exts, out = []) => {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, exts, out);
        else if (exts.includes(path.extname(entry.name))) out.push(full);
    }
    return out;
};

const SOURCE_DIRS = ["src", "tests", "scripts", "prisma"];
const EXTS = [".ts", ".tsx", ".js", ".mjs"];

const files = SOURCE_DIRS.flatMap((d) => walk(path.join(ROOT, d), EXTS));
const corpus = files.map((f) => fs.readFileSync(f, "utf8"));

const isImported = (name) => {
    const re = new RegExp(`(?:from\\s*|require\\(\\s*)["']${name.replace("/", "\\/")}["']`);
    return corpus.some((text) => re.test(text));
};

// `prisma.config.ts` sits at the package root rather than under `src`.
const rootConfig = path.join(ROOT, "prisma.config.ts");
if (fs.existsSync(rootConfig)) corpus.push(fs.readFileSync(rootConfig, "utf8"));

/**
 * Packages that are required without being imported.
 *
 * `mysql2` is the MySQL driver Prisma's engine loads at runtime, and the
 * toolchain packages are invoked from `package.json` scripts or `npx` rather
 * than imported, so a purely import-based scan would wrongly flag them.
 */
const REQUIRED_INDIRECTLY = new Set([
    "mysql2", // Prisma MySQL engine driver
    "prisma", // CLI: `npx prisma migrate|generate|db push`
    "typescript", // `tsc --noEmit`
    "ts-node", // `npm start`, `db:seed`
    "nodemon", // `npm run dev`
    "cross-env", // `npm run test:db`
]);

const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

// A package named in an npm script counts as used.
const scriptText = Object.values(pkg.scripts || {}).join("\n");
const usedByScript = (name) => scriptText.includes(name);

const unused = [];
for (const section of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(pkg[section] || {})) {
        const bare = name.replace(/^@[^/]+\//, "");
        if (REQUIRED_INDIRECTLY.has(name) || usedByScript(name)) continue;
        if (name.startsWith("@types/")) {
            if (isImported(bare)) continue;
        } else if (!isImported(name)) {
            unused.push({ section, name });
        }
    }
}

if (unused.length === 0) {
    console.log("dependency check passed: every declared package is imported");
} else {
    console.log("Unused dependencies:\n");
    for (const { section, name } of unused) {
        console.log(`  ${section.padEnd(15)} ${name}`);
    }
}

if (process.argv.includes("--write") && unused.length > 0) {
    for (const { section, name } of unused) {
        delete pkg[section][name];
        console.log(`removed ${name} from ${section}`);
    }
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    process.exitCode = 1; // the lockfile now needs regenerating
}
