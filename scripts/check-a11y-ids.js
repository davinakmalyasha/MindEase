// Repo-wide duplicate-id / orphaned-label audit.
//
// Static, on purpose. The real version of this check needs a browser and a
// registry, and this repository does not have one, so this is the approximation:
// for every `id="..."` in the client tree, and every `htmlFor="..."`, is the
// target present in the same file, and does anything claim to already own it?
//
// The bug it was written for: `login/page.tsx` had `auth-email` and
// `auth-password` on the login inputs, and the register form's labels pointing
// at the same two ids while its own inputs carried no id at all. Clicking
// "Email" on the sign-up form focused nothing, and a screen reader announced a
// field with no accessible name.

const fs = require("fs");
const path = require("path");

const CLIENT = path.join(__dirname, "..", "client");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "test-results") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(CLIENT);
const problems = [];

for (const file of files) {
  const rel = path.relative(CLIENT, file).replace(/\\/g, "/");
  const src = fs.readFileSync(file, "utf8");

  const ids = [];
  for (const m of src.matchAll(/\bid\s*=\s*"([^"]+)"/g)) ids.push(m[1]);

  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  for (const d of [...new Set(dupes)]) {
    problems.push(`${rel}: id "${d}" is used more than once`);
  }

  // A file that builds its ids from an expression cannot be checked statically,
  // so it is skipped rather than guessed at. This test has to look only at
  // whether an id *attribute* is dynamic.
  //
  // The first version of this check instead tried to be clever and tested
  // `!src.includes('"' + target + '"')` as a fallback for dynamic ids. That test
  // is always false for any label, because `htmlFor="auth-email"` contains the
  // substring `"auth-email"` - so the check could never report an orphaned label,
  // which is the only thing it was written to do. It reported a clean tree for
  // the exact bug that motivated it. `scripts/check-a11y-ids.test.js` caught it,
  // and would not have existed had the gate shipped unwritten-proof.
  const dynamicIds = /id=\{/.test(src);

  const fors = [];
  for (const m of src.matchAll(/\bhtmlFor\s*=\s*"([^"]+)"/g)) fors.push(m[1]);

  if (!dynamicIds) {
    for (const target of fors) {
      if (!ids.includes(target)) {
        problems.push(`${rel}: <label htmlFor="${target}"> has no matching id in this file`);
      }
    }

    // Two labels pointing at one id is the signature of the bug this gate was
    // written for, and it is the *only* thing about that bug a file-local check
    // can see.
    //
    // `login/page.tsx` renders the sign-in and sign-up forms from one component
    // tree, switching between them with a ternary. The sign-in inputs carried
    // `id="auth-email"` and `id="auth-password"`; the sign-up inputs carried no
    // id at all, and the sign-up labels still pointed at the sign-in ids. Every
    // id resolved, so no "orphaned label" finding was possible - and clicking
    // "Email" on the sign-up form focused nothing, while a screen reader read out
    // a field whose accessible name belonged to a different form.
    //
    // So the id check alone is insufficient and always was. Two labels for one id
    // is the thing that is actually wrong, and it is detectable here.
    for (const target of [...new Set(fors)]) {
      const n = fors.filter((f) => f === target).length;
      if (n > 1) {
        problems.push(
          `${rel}: ${n} labels all point at htmlFor="${target}", which only ${ids.filter((i) => i === target).length} element(s) carry`
        );
      }
    }
  }
}

if (problems.length === 0) {
  console.log(`a11y-ids: no duplicate or orphaned ids across ${files.length} tsx files.`);
  process.exit(0);
}

console.error(`a11y-ids found ${problems.length} problem(s):\n`);
for (const p of problems) console.error(`  ${p}`);
console.error("");
process.exit(1);