#!/usr/bin/env node
/**
 * Parses the workflow files well enough to say something useful about them.
 *
 * Not a YAML library. It checks the four things that have actually gone wrong in
 * these three files, and it fails rather than guessing:
 *
 *   1. Every job has `permissions`, `timeout-minutes` and `runs-on`.
 *   2. Every `needs:` names a job that exists.
 *   3. Every `uses:` is pinned to a 40-character SHA. This is the gate for
 *      `scripts/pin-actions.js` - a tool that rewrites workflow files and a
 *      check that the rewrite happened is one control, not two.
 *   4. No `pull_request_target`, no `set -x`, and no `secrets.*` interpolated
 *      directly into a shell string.
 *
 * It deliberately does not try to be a general YAML parser. A homegrown one
 * would be wrong about more than it is right, and `actionlint` or a real parser
 * is the right tool for anything structural.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DIR = path.resolve(__dirname, "..", ".github", "workflows");
const SHA = /@[0-9a-f]{40}(\s|$)/;

const problems = [];
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".yml"));

/** Indentation of a line, in spaces. Tabs are a problem in YAML. */
const indentOf = (line) => {
  if (/^\t/.test(line)) return -1;
  return (line.match(/^ */) || [""])[0].length;
};

for (const file of files) {
  const src = fs.readFileSync(path.join(DIR, file), "utf8");
  const lines = src.split("\n");

  // --- 1. structural checks -------------------------------------------------

  if (/\t/.test(src)) {
    problems.push(`${file}: contains a tab. YAML forbids tabs for indentation.`);
  }

  // Job headers are only jobs if they appear under the top-level `jobs:` key.
  //
  // Without that restriction, `push:`, `pull_request:` and `schedule:` under
  // `on:` are read as jobs - which is what the first version of this script did,
  // reporting fifteen phantom jobs that "have no permissions block".
  const jobsKeyIndex = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsKeyIndex === -1) {
    problems.push(`${file}: no top-level "jobs:" key`);
    continue;
  }

  const jobHeader = /^ {2}([a-zA-Z0-9_-]+):\s*$/gm;
  const jobs = [];
  let m;
  while ((m = jobHeader.exec(src)) !== null) {
    const lineNo = src.slice(0, m.index).split("\n").length;
    if (lineNo <= jobsKeyIndex + 1) continue;
    jobs.push({ name: m[1], startLine: lineNo });
  }
  const jobNames = new Set(jobs.map((j) => j.name));

  for (const job of jobs) {
    // Everything between this job's header and the next one.
    const from = job.startLine;
    const nextStart = jobs.find((j) => j.startLine > from)?.startLine ?? lines.length + 1;
    const body = lines.slice(from - 1, nextStart - 1).join("\n");

    if (!/^\s+permissions:/m.test(body)) {
      problems.push(`${file}: job "${job.name}" has no permissions block`);
    }
    if (!/^\s+timeout-minutes:/m.test(body)) {
      problems.push(`${file}: job "${job.name}" has no timeout-minutes`);
    }
    if (!/^\s+runs-on:/m.test(body)) {
      problems.push(`${file}: job "${job.name}" has no runs-on`);
    }

    for (const n of body.matchAll(/needs:\s*\[([^\]]*)\]/g)) {
      for (const dep of n[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!jobNames.has(dep)) {
          problems.push(`${file}: job "${job.name}" needs "${dep}", which is not a job`);
        }
      }
    }
    for (const n of body.matchAll(/needs:\s*([a-zA-Z0-9_-]+)\s*$/gm)) {
      if (!jobNames.has(n[1])) {
        problems.push(`${file}: job "${job.name}" needs "${n[1]}", which is not a job`);
      }
    }
  }

  // --- 2. pinning -----------------------------------------------------------

  for (const [i, line] of lines.entries()) {
    const uses = line.match(/uses:\s*(\S+)/);
    if (!uses) continue;
    const ref = uses[1];
    if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
    if (!SHA.test(` ${ref} `)) {
      problems.push(
        `${file}:${i + 1}: ${ref} is not pinned to a commit SHA  (node scripts/pin-actions.js --write)`
      );
    }
  }

  // --- 3. hazard patterns ---------------------------------------------------

  // Track whether a line is inside a `run:` script. Passing a secret through
  // `env:` and referencing `$VAR` in the script is correct; interpolating
  // `${{ secrets.X }}` into the script text is what puts it in a process listing
  // and in a log line if the command fails. Only the second is a finding, and the
  // first version of this check flagged both - nine of the ten it reported were
  // correct `env:` blocks.
  let inRunBlock = false;
  let runIndent = 0;

  lines.forEach((line, i) => {
    if (/pull_request_target/.test(line)) {
      problems.push(`${file}:${i + 1}: pull_request_target runs with repository secrets`);
    }
    if (/^\s*set -x\s*$/.test(line)) {
      problems.push(`${file}:${i + 1}: set -x will echo any secret that reaches the shell`);
    }

    const indent = indentOf(line);
    const trimmed = line.trim();

    if (/^run:\s*\|/.test(trimmed) || /^run:\s*>/.test(trimmed)) {
      inRunBlock = true;
      runIndent = indent;
      return;
    }
    // A `run:` with an inline command on the same line.
    if (/^run:\s*\S/.test(trimmed)) {
      if (/\$\{\{\s*secrets\./.test(line)) {
        problems.push(`${file}:${i + 1}: a secret is interpolated into a one-line run:`);
      }
      return;
    }

    if (inRunBlock) {
      // The block ends at the first line indented no further than `run:`.
      if (trimmed === "" || indent > runIndent) {
        if (/\$\{\{\s*secrets\./.test(line)) {
          problems.push(
            `${file}:${i + 1}: a secret is interpolated into the script rather than passed through env:`
          );
        }
        return;
      }
      inRunBlock = false;
    }
  });
}

// --- report ------------------------------------------------------------------

const jobTotal = files.reduce(
  (n, f) => n + (fs.readFileSync(path.join(DIR, f), "utf8").match(/^ {2}[a-zA-Z0-9_-]+:\s*$/gm) || []).length,
  0
);
const usesTotal = files.reduce(
  (n, f) =>
    n +
    (fs.readFileSync(path.join(DIR, f), "utf8")
      .split("\n")
      .filter((l) => /uses:\s*\S+/.test(l) && !/uses:\s*\.\//.test(l)).length),
  0
);

console.log(`check-workflows — ${files.length} files, ${jobTotal} jobs, ${usesTotal} action references\n`);

if (problems.length === 0) {
  console.log("Every job declares permissions, a timeout and a runner; every needs: resolves;");
  console.log("every action reference is pinned to a SHA; no target-trigger, no set -x, and no");
  console.log("secret interpolated into a script.");
  process.exit(0);
}

console.error(`check-workflows found ${problems.length} problem(s):\n`);
for (const p of problems) console.error(`  ${p}`);
console.error("");
process.exit(1);