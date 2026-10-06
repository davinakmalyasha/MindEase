// Exercises buildApiPath without touching the network.
const path = require("path");

const src = require("fs").readFileSync(path.join(__dirname, "..", "scripts", "pin-actions.js"), "utf8");

const grab = (name) => {
  const m = new RegExp(`const ${name} = (\\/[^\\n]+\\/);`).exec(src);
  if (!m) throw new Error(`pattern ${name} not found`);
  return eval(m[1]);
};
const OWNER = grab("OWNER");
const ACTION = grab("ACTION");
const REF = grab("REF");
const SHA40 = grab("SHA40");

const cases = [
  // [segment, owner, action, ref, expected truthiness of the result]
  ["ref", "actions", "checkout", "v5", true],
  ["ref", "aquasecurity", "trivy-action", "v0.36.0", true],
  ["ref", "github", "codeql-action", "init", true],
  ["ref", "davinakmalyasha", "MindEase", "main", true],

  // Path traversal and path termination.
  ["ref", "actions", "checkout", "../../../evil", false],
  ["ref", "actions", "checkout", "v5/../../admin", false],
  ["ref", "actions/../x", "checkout", "v5", false],
  ["ref", "actions", "checkout/../x", "v5", false],

  // Query and fragment injection.
  ["ref", "actions", "checkout", "v5?x=1", false],
  ["ref", "actions", "checkout", "v5#frag", false],

  // Absolute URL smuggling in the owner.
  ["ref", "evil.com", "checkout", "v5", false],
  ["ref", "api.github.com", "checkout", "v5", false],

  // Whitespace and control characters.
  ["ref", "actions", "checkout", "v5 ref", false],
  ["ref", "actions", "che ckout", "v5", false],
  ["ref", "act ions", "checkout", "v5", false],

  // Empty and oversized.
  ["ref", "", "checkout", "v5", false],
  ["ref", "actions", "", "v5", false],
  ["ref", "actions", "checkout", "", false],
  ["ref", "actions", "checkout", "v".repeat(200), false],
  ["ref", "a".repeat(100), "checkout", "v5", false],

  // The deref segment only accepts a SHA.
  ["tags", "actions", "checkout", "0".repeat(40), true],
  ["tags", "actions", "checkout", "f".repeat(40), true],
  ["tags", "actions", "checkout", "../../etc/passwd", false],
  ["tags", "actions", "checkout", "v5", false],
  ["tags", "actions", "checkout", "A".repeat(40), false],

  // Unknown segment.
  ["other", "actions", "checkout", "v5", false],
];

function build(owner, action, segment, ref) {
  if (!OWNER.test(owner) || !ACTION.test(action)) return null;
  if (segment === "ref") {
    if (!REF.test(ref)) return null;
    return `/repos/${owner}/${action}/git/ref/tags/${encodeURIComponent(ref)}`;
  }
  if (segment === "tags") {
    if (!SHA40.test(ref)) return null;
    return `/repos/${owner}/${action}/git/tags/${ref}`;
  }
  return null;
}

let failed = 0;
for (const [segment, owner, action, ref, want] of cases) {
  const got = build(owner, action, segment, ref) !== null;
  const label = `${segment} ${owner}/${action}@${ref}`;
  if (got === want) {
    console.log(`ok   ${want ? "accepts" : "rejects"}  ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${got ? "accepted" : "rejected"} ${label} - expected ${want ? "accept" : "reject"}`);
  }
}

if (failed) {
  console.error(`\n${failed} of ${cases.length} case(s) failed.`);
  process.exit(1);
}
console.log(`\npin-actions path allowlist: ${cases.length} cases passed.`);

// ---------------------------------------------------------------------------
// The line-splitting behaviour, which is where the real bug was.
//
// `security.yml` is checked out with CRLF on Windows. The `uses:` regex ends in
// `$`, `.` does not match `\r`, and so splitting on `"\n"` made all sixteen of
// its references invisible: the tool reported "0 references on a mutable tag" on
// a repository where every reference is pinned, and would have reported the same
// about an unpinned one and then changed nothing.
//
// This asserts the regex matches a reference with and without the carriage
// return, which is the property that was missing.
const USES = (() => {
  const m = /^const USES = (\/.*\/);$/m.exec(src);
  if (!m) throw new Error("USES pattern not found");
  return eval(m[1]);
})();

const SHA = "a".repeat(40);
const splitCases = [
  { name: "LF line ending", line: `      - uses: actions/checkout@${SHA} # v5` },
  { name: "CRLF line ending", line: `      - uses: actions/checkout@${SHA} # v5\r` },
  { name: "CRLF, no trailing comment", line: `      - uses: actions/checkout@${SHA}\r` },
  { name: "CRLF, mutable tag", line: `        uses: aquasecurity/trivy-action@v0.36.0\r` },
  { name: "CRLF, docker ref is not an action", line: `        uses: docker://alpine:3.20\r` },
];

let splitFailed = 0;
for (const c of splitCases) {
  const shouldMatch = !c.line.includes("docker://");
  const got = USES.test(c.line);
  if (got === shouldMatch) console.log(`ok   ${c.name} (${got ? "matched" : "ignored"})`);
  else {
    splitFailed += 1;
    console.error(`FAIL ${c.name} - expected ${shouldMatch ? "match" : "no match"}`);
  }
}

if (splitFailed) {
  console.error(`\n${splitFailed} line-ending case(s) failed.`);
  process.exit(1);
}
console.log(`pin-actions line handling: ${splitCases.length} cases passed.`);