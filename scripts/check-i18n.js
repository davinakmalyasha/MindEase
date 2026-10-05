// Fails on a `t("...")` call that cannot resolve in the message files.
//
// The bug this exists for: `components/layout/Navbar.tsx` called `t("signUp")`
// through `useTranslations("nav")`, and `nav.signUp` did not exist in either
// `messages/en.json` or `messages/id.json`. next-intl throws on an unresolvable
// key, so the navbar threw on every page of the application - including the sign-
// in page, which is why signing in appeared to fail with an empty form and no
// error message.
//
// The parity test already in the client suite did not catch it, and could not:
// both locales were missing the key, so the two files agreed with each other. It
// is the wrong shape of check for this failure. Parity proves the translations
// are equally complete; only a check against the call sites proves they are
// complete at all.

const fs = require("fs");
const path = require("path");

const CLIENT = path.join(__dirname, "..", "client");
const MESSAGES = path.join(CLIENT, "messages");

/** Recursively collect every source file we can read translations out of. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "test-results", "playwright-report"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Whether a dotted path resolves to a string in a message object. */
function resolves(obj, dotted) {
  let cur = obj;
  for (const seg of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return false;
    if (!(seg in cur)) return false;
    cur = cur[seg];
  }
  return typeof cur === "string";
}

const locales = fs
  .readdirSync(MESSAGES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f.replace(/\.json$/, ""), data: JSON.parse(fs.readFileSync(path.join(MESSAGES, f), "utf8")) }));

if (!locales.length) {
  console.error("check-i18n: no message files found under client/messages");
  process.exit(1);
}

const problems = [];

for (const file of walk(CLIENT)) {
  const rel = path.relative(CLIENT, file).replace(/\\/g, "/");
  const src = fs.readFileSync(file, "utf8");

  // `const t = useTranslations("nav")`, `const tc = useTranslations("common")`.
  // The binding name matters: `t` and `tc` resolve against different namespaces,
  // so a checker that assumes every translator is called `t` either misses real
  // keys or invents them.
  //
  // One name can be bound more than once in a file. `components/doctors/
  // DoctorProfile.tsx` binds `t` to `features.reviewReply` inside a nested
  // component and to `features.doctorProfile` in the outer one, so a single
  // namespace per name is simply wrong - taking the last binding produced 26
  // findings, all 26 of them false.
  //
  // Scope-aware resolution would mean tracking JS block scopes, which is more
  // machinery than this check is worth. Instead a key passes if it resolves under
  // *any* namespace bound to that name in the file. That is permissive by design:
  // it can only miss a bug, never invent one, and missing is the acceptable
  // direction for a gate nobody has asked to be exhaustive.
  const byName = new Map();
  for (const [, name, ns] of src.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*useTranslations\(\s*"([^"]+)"\s*\)/g
  )) {
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(ns);
  }

  if (!byName.size) continue;

  for (const [name, namespaces] of byName) {
    const escaped = name.replace(/\$/g, "\\$");
    // Calls on a known binding: `t("key")`, `t.rich("key")`, `tc("key")`.
    const callRe = new RegExp(`\\b${escaped}(?:\\.\\w+)?\\(\\s*"([^"]+)"`, "g");
    for (const [, key] of src.matchAll(callRe)) {
      const candidates = [...namespaces].map((ns) => `${ns}.${key}`);
      for (const loc of locales) {
        if (candidates.some((d) => resolves(loc.data, d))) continue;
        problems.push(
          `${rel}: ${name}("${key}") -> ${candidates.map((d) => `"${d}"`).join(" or ")} is missing from messages/${loc.name}.json`
        );
      }
    }
  }
}

if (problems.length) {
  console.error(`check-i18n found ${problems.length} unresolvable message key(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("");
  process.exit(1);
}

console.log(
  `check-i18n: every literal translation key resolves in all ${locales.length} locale(s).`
);