// Self-test for scripts/check-workflows.js.
//
// The script's job-counting is the part a reviewer reads and the part that was
// wrong: it reported 27 jobs for 17, because the summary summed every two-space
// `key:` in the file and so counted the trigger keys under `on:`. The per-job
// loop had already been fixed for exactly that mistake, and the summary had not,
// which is the shape of bug this repository keeps finding - one copy of a rule
// fixed, another copy left behind.
//
// These cases pin the behaviour rather than the implementation, so the boundary
// logic can be rewritten as long as it still tells a trigger from a job.

const assert = require("assert");
const { countJobs, collectJobs, indentationProblems } = require("./check-workflows.js");

const cases = [
  {
    name: "counts jobs and ignores every trigger under on:",
    src: [
      "name: x",
      "on:",
      "  push:",
      "    branches: [main]",
      "  pull_request:",
      "  schedule:",
      "    - cron: '0 3 * * 1'",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "  b:",
      "    runs-on: ubuntu-latest",
    ].join("\n"),
    want: 2,
  },
  {
    name: "does not count top-level keys that are not jobs:",
    src: ["on:", "  push:", "jobs:", "  a:", "    runs-on: x", "permissions:", "  contents: read"].join("\n"),
    want: 1,
  },
  {
    name: "ignores a matrix entry key at deeper indentation",
    src: [
      "jobs:",
      "  scan:",
      "    strategy:",
      "      matrix:",
      "        include:",
      "          - image: server",
      "            dockerfile: server/Dockerfile",
    ].join("\n"),
    want: 1,
  },
  {
    name: "does not count a step-level key at deeper indentation",
    src: [
      "jobs:",
      "  a:",
      "    steps:",
      "      - name: x",
      "        run: echo",
      "      - name: y",
      "        run: echo",
    ].join("\n"),
    want: 1,
  },
  {
    name: "a job named like a trigger is still a job",
    src: ["jobs:", "  push:", "    runs-on: x"].join("\n"),
    want: 1,
  },
  {
    name: "returns 0 when there is no jobs: key",
    src: ["name: x", "on:", "  push:"].join("\n"),
    want: 0,
  },
];

let failed = 0;
for (const c of cases) {
  try {
    const got = countJobs(c.src);
    assert.strictEqual(got, c.want);
    console.log(`ok   ${c.name} (${got})`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${c.name}`);
    console.error(`     ${e.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} of ${cases.length} case(s) failed.`);
  process.exit(1);
}
console.log(`\ncheck-workflows self-test: ${cases.length} cases passed.`);

// The indentation rule is separate from job counting, and has the case that
// motivated it: a `matrix:` at column 0 inside a job. PyYAML rejects the whole
// file, and every other rule here is satisfied by it.
const indentCases = [
  {
    name: "a key that lost its indentation inside a job",
    src: [
      "on:",
      "  push:",
      "jobs:",
      "  scan:",
      "    permissions:",
      "      contents: read",
      "    timeout-minutes: 5",
      "    runs-on: ubuntu-latest",
      "    strategy:",
      "      fail-fast: false",
      "matrix:",
      "        service: [a, b]",
    ].join("\n"),
    want: 1,
  },
  {
    name: "the same workflow with its indentation restored",
    src: [
      "on:",
      "  push:",
      "jobs:",
      "  scan:",
      "    permissions:",
      "      contents: read",
      "    timeout-minutes: 5",
      "    runs-on: ubuntu-latest",
      "    strategy:",
      "      fail-fast: false",
      "      matrix:",
      "        service: [a, b]",
    ].join("\n"),
    want: 0,
  },
  {
    name: "blank lines and comments inside a job are not keys",
    src: [
      "on:",
      "  push:",
      "jobs:",
      "  scan:",
      "    permissions:",
      "      contents: read",
      "    timeout-minutes: 5",
      "",
      "# a comment at column 0",
      "    runs-on: ubuntu-latest",
    ].join("\n"),
    want: 0,
  },
];

let indentFailed = 0;
for (const c of indentCases) {
  const found = indentationProblems(c.src, collectJobs(c.src));
  try {
    assert.strictEqual(found.length, c.want, found.join("; "));
    console.log(`ok   ${c.name} (${found.length})`);
  } catch (e) {
    indentFailed += 1;
    console.error(`FAIL ${c.name}`);
    console.error(`     ${e.message}`);
  }
}

if (indentFailed) {
  console.error(`\n${indentFailed} of ${indentCases.length} indentation case(s) failed.`);
  process.exit(1);
}
console.log(`check-workflows indentation self-test: ${indentCases.length} cases passed.`);