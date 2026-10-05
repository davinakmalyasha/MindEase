// Pins the behaviour of scripts/check-i18n.js.
//
// Two things have to hold, and the second is the one that went wrong first.
//
// 1. It catches an unresolvable key - the Navbar bug.
// 2. It does NOT invent findings when one translator name is bound to two
//    namespaces in the same file. The first version kept one namespace per name,
//    took the last binding, and reported 26 false positives in
//    DoctorProfile.tsx, where `t` means `features.reviewReply` inside one nested
//    component and `features.doctorProfile` in the outer one. A gate that
//    reports 26 phantom defects gets deleted, and then the one real defect goes
//    with it.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const CLIENT = path.join(__dirname, "..", "client");

// Run the real checker as a subprocess so this exercises the shipped code path
// rather than a re-implementation of it.
function run() {
  const { execFileSync } = require("child_process");
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "check-i18n.js")], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

const probe = (body) => path.join(CLIENT, "__i18n_probe__.tsx");

const cases = [
  {
    name: "the Navbar bug: a key missing from one locale only",
    body: `export default function P() {
  const t = useTranslations("nav");
  return <p>{t("definitelyNotThere")}</p>;
}`,
    want: [/__i18n_probe__.*definitelyNotThere/],
  },
  {
    name: "a rebinding of t to a second namespace must not be a finding",
    body: `export default function P() {
  const t = useTranslations("features.reviewReply");
  return <p>{t("credentialsTitle")}</p>;
}

function Nested() {
  const t = useTranslations("features.doctorProfile");
  return <p>{t("publish")}</p>;
}`,
    want: null,
  },
  {
    name: "a key that resolves in at least one bound namespace passes",
    body: `export default function P() {
  const t = useTranslations("nav");
  const tc = useTranslations("common");
  return <p>{t("home")}{tc("loading")}</p>;
}`,
    want: null,
  },
];

let failed = 0;
try {
  for (const c of cases) {
    fs.writeFileSync(probe(c.body), c.body, "utf8");
    const { code, out } = run();

    if (c.want === null) {
      if (code === 0) console.log(`ok   ${c.name}`);
      else {
        failed += 1;
        console.error(`FAIL ${c.name} - expected clean, got:`);
        console.error(out.split("\n").map((l) => `       ${l}`).join("\n"));
      }
      continue;
    }

    const missing = c.want.filter((re) => !re.test(out));
    if (code !== 0 && missing.length === 0) console.log(`ok   ${c.name} (flagged)`);
    else {
      failed += 1;
      console.error(`FAIL ${c.name} - exit ${code}`);
      console.error(out.split("\n").map((l) => `       ${l}`).join("\n"));
    }
  }
} finally {
  fs.rmSync(probe(""), { force: true });
}

if (failed) {
  console.error(`\n${failed} of ${cases.length} case(s) failed.`);
  process.exit(1);
}
console.log(`\ncheck-i18n self-test: ${cases.length} cases passed.`);