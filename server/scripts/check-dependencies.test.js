// Proves server/scripts/check-dependencies.js flags an unused package and stays
// quiet on every legitimate way a dependency is used without being imported.
//
// The config-file case is the real false positive that kept this scanner
// advisory: `@eslint/js` and `typescript-eslint` are imported by
// `eslint.config.mjs`, which the old source-directory list did not include.
// `@vitest/coverage-v8` is selected by configuration value, never imported.

const { findUnused } = require("./check-dependencies.js");

const pkgWith = (dependencies, devDependencies, scripts) => ({
    dependencies: dependencies || {},
    devDependencies: devDependencies || {},
    scripts: scripts || {},
});

const cases = [
    {
        name: "a package nobody references is flagged, with its section",
        pkg: pkgWith({}, { "left-pad": "^1.0.0" }),
        corpus: ['import x from "express";'],
        expect: (unused) =>
            unused.length === 1 &&
            unused[0].name === "left-pad" &&
            unused[0].section === "devDependencies",
    },
    {
        name: "a runtime dependency nobody references is flagged as such",
        pkg: pkgWith({ "left-pad": "^1.0.0" }, {}),
        corpus: [],
        expect: (unused) => unused.length === 1 && unused[0].section === "dependencies",
    },
    {
        name: "an import from a config file counts - eslint.config.mjs was the old blind spot",
        pkg: pkgWith({}, { "@eslint/js": "^9.0.0", "typescript-eslint": "^8.0.0" }),
        corpus: ['import js from "@eslint/js";', 'import tseslint from "typescript-eslint";'],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "an import from a test file counts",
        pkg: pkgWith({}, { supertest: "^7.0.0" }),
        corpus: ['import request from "supertest";'],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "a coverage provider selected by name counts as used",
        pkg: pkgWith({}, { "@vitest/coverage-v8": "^4.0.0" }),
        corpus: ["export default { test: { coverage: { provider: \"v8\" } } };"],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "a subpath import counts for the root package",
        pkg: pkgWith({ "@prisma/client": "^6.0.0" }, {}),
        corpus: ['import { Prisma } from "@prisma/client";'],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "a require() counts, not only an ESM import",
        pkg: pkgWith({ "sanitize-html": "^2.0.0" }, {}),
        corpus: ['const sanitizeHtml = require("sanitize-html");'],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "a package named in an npm script counts as used",
        pkg: pkgWith({}, { "ts-node": "^10.0.0" }, { start: "ts-node src/index.ts" }),
        corpus: [],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "INDIRECT members are exempt (the Prisma engine's driver)",
        pkg: pkgWith({ mysql2: "^3.0.0" }, {}),
        corpus: [],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "@types packages are exempt - the compiler consumes them",
        pkg: pkgWith({}, { "@types/node": "^22.0.0" }),
        corpus: [],
        expect: (unused) => unused.length === 0,
    },
];

let failed = 0;
for (const c of cases) {
    let ok = false;
    let detail = "";
    try {
        const unused = findUnused(c.pkg, c.corpus);
        ok = c.expect(unused);
        detail = JSON.stringify(unused);
    } catch (e) {
        detail = e.message;
    }
    if (ok) console.log(`ok   ${c.name}`);
    else {
        failed += 1;
        console.error(`FAIL ${c.name} - got ${detail}`);
    }
}

if (failed) {
    console.error(`\n${failed} of ${cases.length} case(s) failed - the scanner may be broken.`);
    process.exit(1);
}
console.log(`\ncheck-dependencies self-test: ${cases.length} cases passed.`);
