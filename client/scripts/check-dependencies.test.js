// Proves scripts/check-dependencies.js flags an unused package and stays quiet
// on every legitimate way a dependency is used without being imported.
//
// Each false-positive case here is a real one from this package's history:
// `@testing-library/react` (only referenced from `tests/`, which the old
// scanner did not walk), `jsdom` and `@vitest/coverage-v8` (selected by
// configuration value, never imported), and `@testing-library/dom` (a peer of
// RTL). The scanner was advisory for as long as it was wrong, so every one of
// these cases is what lets it gate now.

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
        corpus: ['import x from "react";'],
        expect: (unused) =>
            unused.length === 1 &&
            unused[0].name === "left-pad" &&
            unused[0].section === "devDependencies",
    },
    {
        name: "an import from a test file counts - the old scanner did not walk tests/",
        pkg: pkgWith({}, { "@testing-library/react": "^16.0.0" }),
        corpus: ['import { render } from "@testing-library/react";'],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "an import from a config file counts - the old scanner did not walk eslint.config.mjs",
        pkg: pkgWith({}, { "@eslint/js": "^9.0.0" }),
        corpus: ['import js from "@eslint/js";'],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "an environment selected by name counts as used",
        pkg: pkgWith({}, { jsdom: "^25.0.0" }),
        corpus: ['export default { test: { environment: "jsdom" } };'],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "a coverage provider selected by name counts as used",
        pkg: pkgWith({}, { "@vitest/coverage-v8": "^3.0.0" }),
        corpus: ["export default { test: { coverage: { provider: \"v8\" } } };"],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "a subpath import counts for the root package",
        pkg: pkgWith({ "@hookform/resolvers": "^5.0.0" }, {}),
        corpus: ['import { zodResolver } from "@hookform/resolvers/zod";'],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "a package named in an npm script counts as used",
        pkg: pkgWith({}, { typescript: "^5.0.0" }, { lint: "tsc --noEmit" }),
        corpus: [],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "INDIRECT members are exempt (framework peers)",
        pkg: pkgWith({ "react-dom": "19.2.3" }, {}),
        corpus: [],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "@types packages are exempt - the compiler consumes them",
        pkg: pkgWith({}, { "@types/node": "^22.0.0" }),
        corpus: [],
        expect: (unused) => unused.length === 0,
    },
    {
        name: "the exemption is exact, not a prefix: a lookalike is still flagged",
        pkg: pkgWith({}, { "eslint-plugin-nobody-imports": "^1.0.0" }),
        corpus: ['import x from "eslint";'],
        expect: (unused) => unused.length === 1,
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
