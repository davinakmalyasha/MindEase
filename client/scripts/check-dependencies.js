/**
 * Reports whether each declared dependency is actually imported.
 *
 * An unused dependency is not only bytes: it is unreviewed third-party code in
 * the runtime path. For a platform holding mental-health data, every
 * unnecessary package widens the supply-chain surface and the bundle.
 *
 * Run with `--write` to strip the unused ones from `package.json`.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SKIP = new Set([
    "node_modules", ".next", ".git", "test-results", "coverage", "playwright-report", "out",
]);

const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

const walk = (dir, out = []) => {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (EXTENSIONS.includes(path.extname(entry.name))) out.push(full);
    }
    return out;
};

const SOURCE_DIRS = [
    "app", "components", "lib", "hooks", "context", "i18n", "e2e", "public",
    "proxy.ts", "next.config.mjs", "playwright.config.ts", "eslint.config.mjs",
    "tailwind.config.js", "postcss.config.js",
];

const collect = (target) => {
    const full = path.join(ROOT, target);
    if (!fs.existsSync(full)) return [];
    // A source entry may be a single file (a config) rather than a directory.
    if (fs.statSync(full).isFile()) {
        return EXTENSIONS.includes(path.extname(full)) ? [full] : [];
    }
    return walk(full);
};

const corpus = SOURCE_DIRS.flatMap(collect).map((f) => fs.readFileSync(f, "utf8"));

const isImported = (name) => {
    const escaped = name.replace(/\//g, "\\/");
    // Match a bare import and any subpath import, e.g. `@hookform/resolvers/zod`.
    const re = new RegExp(`(?:from\\s*|require\\(\\s*)["']${escaped}(?:/[^"']*)?["']`);
    return corpus.some((text) => re.test(text));
};

/**
 * Packages required without being imported.
 *
 * `react-dom` is Next.js's own peer: the App Router renders through it, but no
 * source file imports it directly.
 */
const INDIRECT = new Set([
    "typescript", "tailwindcss", "postcss", "autoprefixer", "eslint",
    "eslint-config-next", "tsx", "ts-node", "dotenv", "react", "react-dom",
    "@types/node", "@types/react", "@types/react-dom",
]);

const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const scriptText = Object.values(pkg.scripts || {}).join("\n");

const unused = [];
for (const section of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(pkg[section] || {})) {
        if (INDIRECT.has(name) || scriptText.includes(name)) continue;
        if (name.startsWith("@types/")) {
            if (isImported(name.replace(/^@[^/]+\//, ""))) continue;
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
