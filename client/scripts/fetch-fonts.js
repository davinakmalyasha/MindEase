/**
 * Fetch the woff2 files for the three families `app/layout.tsx` uses, so the
 * build no longer reaches out to Google Fonts at compile time.
 *
 * Run once; the output is committed. Re-run only to upgrade the fonts.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const OUT = path.resolve(__dirname, "../app/fonts");

// A modern desktop UA is what makes Google Fonts serve woff2 rather than ttf.
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const FAMILIES = [
    {
        name: "geist",
        url: "https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap",
        file: "Geist-Variable.woff2",
    },
    {
        name: "geist-mono",
        url: "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&display=swap",
        file: "GeistMono-Variable.woff2",
    },
    {
        name: "jakarta",
        url: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300..800&display=swap",
        file: "PlusJakartaSans-Variable.woff2",
    },
];

const get = (url, binary = false) =>
    new Promise((resolve, reject) => {
        https
            .get(url, { headers: { "User-Agent": UA } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return resolve(get(res.headers.location, binary));
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`${url} -> HTTP ${res.statusCode}`));
                }
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () =>
                    resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8"))
                );
            })
            .on("error", reject);
    });

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    for (const fam of FAMILIES) {
        const css = await get(fam.url);
        // The `latin` block is the one we subset to; take the last @font-face src,
        // which for a variable request is the full-range latin file.
        const blocks = css.split("@font-face").filter((b) => b.includes("woff2"));
        const latin =
            blocks.find((b) => /\/\*\s*latin\s*\*\//.test(css.slice(0, css.indexOf(b)).slice(-200))) ||
            blocks[blocks.length - 1];
        const m = /url\((https:[^)]+\.woff2)\)/.exec(latin || "");
        if (!m) {
            console.error(`  ${fam.name}: no woff2 in the CSS`);
            console.error(css.slice(0, 400));
            process.exit(1);
        }
        const buf = await get(m[1], true);
        fs.writeFileSync(path.join(OUT, fam.file), buf);
        console.log(`  ${fam.file}  ${(buf.length / 1024).toFixed(1)} KB`);
    }
    // A licence note travels with the files; both families are SIL OFL 1.1.
    fs.writeFileSync(
        path.join(OUT, "README.md"),
        [
            "# Self-hosted fonts",
            "",
            "Downloaded from Google Fonts by `scripts/fetch-fonts.js` and committed here so",
            "that `next build` never depends on reaching `fonts.googleapis.com`.",
            "",
            "`next/font/google` fetches at build time. That made the build fail on a",
            "transient network error - once in CI, and once locally - with",
            "`Failed to fetch Geist from Google Fonts` and",
            "`Can't resolve '@vercel/turbopack-next/internal/font/google/font'`, which",
            "reads like a broken dependency rather than a flaky network.",
            "",
            "| File | Family | Licence |",
            "|---|---|---|",
            "| `Geist-Variable.woff2` | Geist | SIL Open Font License 1.1 |",
            "| `GeistMono-Variable.woff2` | Geist Mono | SIL Open Font License 1.1 |",
            "| `PlusJakartaSans-Variable.woff2` | Plus Jakarta Sans | SIL Open Font License 1.1 |",
            "",
            "All three are variable fonts covering the full weight range the layout uses.",
            "",
            "To upgrade: change the ranges in `scripts/fetch-fonts.js`, re-run it, and",
            "commit the new files.",
        ].join("\n")
    );
    console.log("  wrote README.md");
})();