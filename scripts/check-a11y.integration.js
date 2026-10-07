// Proves check-a11y.js fails on a real regression, by breaking a real file and
// restoring it. Run manually; it edits the working tree.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TARGET = path.join(__dirname, "..", "client", "app", "login", "page.tsx");
const GATE = path.join(__dirname, "check-a11y.js");
const original = fs.readFileSync(TARGET, "utf8");

const cases = [
  {
    name: "a submit button stripped of its visible label",
    // A translation call is the common case and the one most likely to be
    // mis-detected, so this is the label that gets removed.
    broken: original.replace(': t("signIn")}', ": null}"),
    expect: /no accessible name/,
  },
  {
    name: "a field error stripped of role=alert",
    broken: original.replace('role="alert" ', "").replace(' role="alert"', ""),
    expect: /never announced/,
  },
];

let failed = 0;
try {
  for (const c of cases) {
    if (c.broken === original) {
      failed += 1;
      console.error(`FAIL ${c.name} - the substitution did not change the file, so nothing was proven`);
      continue;
    }
    fs.writeFileSync(TARGET, c.broken, "utf8");
    let out = "";
    let code = 0;
    try {
      out = execFileSync(process.execPath, [GATE], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      code = e.status;
      out = `${e.stdout || ""}${e.stderr || ""}`;
    }
    if (code !== 0 && c.expect.test(out)) console.log(`ok   caught: ${c.name}`);
    else {
      failed += 1;
      console.error(`FAIL missed: ${c.name} (exit ${code})`);
      console.error(out.split("\n").slice(0, 6).map((l) => `       ${l}`).join("\n"));
    }
  }
} finally {
  fs.writeFileSync(TARGET, original, "utf8");
}

if (failed) {
  console.error(`\n${failed} of ${cases.length} case(s) failed.`);
  process.exit(1);
}
console.log(`\ncheck-a11y integration: ${cases.length} cases passed.`);