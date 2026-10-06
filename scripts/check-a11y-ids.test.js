// Sanity check for scripts/check-a11y-ids.js.
//
// A gate that cannot fail is worse than no gate, so this proves the detector
// still detects. Each case is written to a temporary .tsx file inside
// client/, which is the only directory the checker walks.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CLIENT = path.join(__dirname, "..", "client");
const TMP = path.join(CLIENT, "__a11y_probe__.tsx");

const cases = [
  {
    name: "the real login bug: sign-up labels point at the sign-in inputs' ids",
    body: `export default function P() {
  return (<>
    <label htmlFor="auth-email">Email</label>
    <input id="auth-email" />
    <label htmlFor="auth-email">Email</label>
    <input />
    <label htmlFor="auth-password">Password</label>
    <input id="auth-password" type="password" />
    <label htmlFor="auth-password">Password</label>
    <input type="password" />
  </>);
}`,
    // Every id resolves here, so an orphaned-label check cannot see it. This is
    // the case that proves the shared-target check is load-bearing.
    want: [/2 labels all point at htmlFor="auth-email"/, /2 labels all point at htmlFor="auth-password"/],
  },
  {
    name: "a label pointing at an id that no input carries",
    body: `export default function P() {
  return (<>
    <label htmlFor="register-email">Email</label>
    <input id="auth-email" />
  </>);
}`,
    want: [/register-email.*has no matching id/],
  },
  {
    name: "a label with no id anywhere in the file",
    body: `export default function P() {
  return (<>
    <label htmlFor="phone">Phone</label>
    <input type="tel" />
  </>);
}`,
    want: [/phone.*has no matching id/],
  },
  {
    name: "a genuine repeated id in one file is still reported",
    body: `export default function P() {
  return (<>
    <label htmlFor="email">Email</label>
    <input id="email" />
    <div id="email" />
  </>);
}`,
    want: [/id "email" is used more than once/],
  },
  {
    name: "a correct label/input pair must not be reported",
    body: `export default function P() {
  return (<>
    <label htmlFor="email">Email</label>
    <input id="email" />
    <label htmlFor="password">Password</label>
    <input id="password" type="password" />
  </>);
}`,
    want: null,
  },
  {
    name: "a file with expression-built ids is skipped rather than guessed at",
    body: `export default function P({ id }) {
  return (<>
    <label htmlFor="f">F</label>
    <input id={\`field-\${id}\`} />
  </>);
}`,
    want: null,
  },
];

function run() {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "check-a11y-ids.js")], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

let failed = 0;
try {
  for (const c of cases) {
    fs.writeFileSync(TMP, c.body, "utf8");
    const { code, out } = run();
    if (c.want === null) {
      if (code === 0) {
        console.log(`ok   ${c.name} (clean)`);
      } else {
        failed += 1;
        console.error(`FAIL ${c.name} - expected no finding, got:`);
        console.error(out.split("\n").map((l) => `       ${l}`).join("\n"));
      }
      continue;
    }
    const missing = c.want.filter((re) => !re.test(out));
    if (code !== 0 && missing.length === 0) {
      console.log(`ok   ${c.name} (flagged, exit ${code})`);
    } else {
      failed += 1;
      console.error(`FAIL ${c.name} - exit ${code}`);
      if (missing.length) console.error(`       missing: ${missing.map(String).join(", ")}`);
      console.error(out.split("\n").map((l) => `       ${l}`).join("\n"));
    }
  }
} finally {
  fs.rmSync(TMP, { force: true });
}

if (failed) {
  console.error(`\n${failed} of ${cases.length} case(s) failed - the detector may be broken.`);
  process.exit(1);
}
console.log(`\ncheck-a11y-ids self-test: ${cases.length} cases passed.`);