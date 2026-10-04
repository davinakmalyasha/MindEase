#!/usr/bin/env node
/**
 * Rewrites every `uses: owner/action@ref` in `.github/workflows/*.yml` to a full
 * commit SHA, with the tag kept in a trailing comment so a human can still read
 * what the reference was.
 *
 *     - uses: actions/checkout@v5          # v5.2.0
 *     + uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v5
 *
 * Why this exists
 * ---------------
 * A tag is a mutable ref. `actions/checkout@v5` runs eleven times across this
 * repository's three workflows, and whoever controls the tag can change the code
 * that runs - with the workflow's own token, in this repository, on a pull
 * request. Pinning to a SHA makes the thing that runs immutable; the comment
 * keeps the upgrade path legible, because "bump checkout" has to be findable by
 * grep.
 *
 * This is the single largest supply-chain exposure in the repository, and it is
 * the only one of the security controls that was configured but ineffective:
 * CodeQL, gitleaks, Trivy and npm audit were all wired, and none of them
 * constrains what a compromised action could do.
 *
 * Dependabot does not manage these SHAs on its own. `.github/dependabot.yml`
 * covers the docker, npm and gomod ecosystems; there is a `github-actions`
 * ecosystem available precisely for this, and enabling it is the other half of
 * this change.
 *
 * Usage:
 *   node scripts/pin-actions.js            # report what would change
 *   node scripts/pin-actions.js --write    # rewrite the workflow files
 *
 * Resolving a tag to a SHA needs the network. Without it the script only reports,
 * so it degrades to a linter rather than failing - which is what you want from a
 * maintenance tool.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const WORKFLOWS = path.resolve(__dirname, "..", ".github", "workflows");
const WRITE = process.argv.includes("--write");

/** `uses: owner/action@ref`, local actions and docker refs excluded. */
const USES = /^(\s*-?\s*uses:\s*)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+)@([^\s#]+)(\s*)(#.*)?$/;

/** A 40-character hex SHA is already pinned. */
const SHA = /^[0-9a-f]{40}$/;

const files = fs
  .readdirSync(WORKFLOWS)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => path.join(WORKFLOWS, f));

/** Resolves `owner/action@tag` to the commit SHA the tag points at. */
function apiGet(apiPath) {
  return new Promise((resolve) => {
    const req = https.get(
      {
        host: "api.github.com",
        path: apiPath,
        headers: {
          "User-Agent": "mindease-pin-actions",
          Accept: "application/vnd.github+json",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          const retryAfter = res.headers["retry-after"];
          res.resume();
          resolve({ ok: false, status: `${res.statusCode}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}` });
          return;
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve({ ok: true, json: JSON.parse(body) });
          } catch {
            resolve({ ok: false, status: "unparseable" });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ ok: false, status: err.message }));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ ok: false, status: "timeout" });
    });
  });
}

/**
 * Resolves `owner/action@ref` to the commit SHA.
 *
 * Two shapes have to be handled. A *lightweight* tag points straight at a commit,
 * so `git/ref/tags/{tag}` returns that commit's SHA. An *annotated* tag points at
 * a tag object whose `sha` is not a commit, and has to be dereferenced through
 * `git/tags/{sha}` to reach the commit. Half the interesting actions here use the
 * annotated form, and returning the tag object's SHA would produce a reference
 * that fails at run time - which is worse than an unpinned one, because it looks
 * done.
 *
 * Results are cached to disk, including failures, because the unauthenticated
 * GitHub API allows 60 requests an hour and this repository references more
 * than a dozen distinct actions across three workflows.
 */
const CACHE_PATH = path.join(__dirname, ".pin-actions-cache.json");

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function resolveSha(owner, action, ref, cache) {
  const key = `${owner}/${action}@${ref}`;
  if (cache[key] !== undefined) return cache[key];

  const res = await apiGet(
    `/repos/${owner}/${action}/git/ref/tags/${encodeURIComponent(ref)}`
  );

  if (!res.ok) {
    cache[key] = { ok: false, status: res.status };
    return cache[key];
  }

  const object = res.json.object;
  if (!object) {
    cache[key] = { ok: false, status: "no object in response" };
    return cache[key];
  }

  if (object.type === "tag") {
    // Annotated: one more hop to reach the commit.
    const deref = await apiGet(`/repos/${owner}/${action}/git/tags/${object.sha}`);
    if (!deref.ok) {
      cache[key] = { ok: false, status: `deref failed: ${deref.status}` };
      return cache[key];
    }
    const commit = deref.json.object;
    cache[key] = commit && commit.type === "commit"
      ? { ok: true, sha: commit.sha }
      : { ok: false, status: "annotated tag does not resolve to a commit" };
    return cache[key];
  }

  cache[key] = { ok: true, sha: object.sha };
  return cache[key];
}

(async () => {
  const todo = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(USES);
      if (!m) continue;
      const [, , ownerAction, ref] = m;
      if (SHA.test(ref)) continue;
      todo.push({ file: path.relative(path.resolve(__dirname, ".."), file), line, ownerAction, ref });
    }
  }

  const unpinned = todo.filter((t) => !SHA.test(t.ref));
  const already = todo.length - unpinned.length;

  console.log(`pin-actions\n`);
  console.log(`  ${files.length} workflow files`);
  console.log(`  ${already} references already pinned to a SHA`);
  console.log(`  ${unpinned.length} references on a mutable tag\n`);

  if (unpinned.length === 0) {
    console.log("Every action reference is pinned. Nothing to do.");
    return;
  }

  // De-duplicate: the same action@tag is referenced many times.
  const unique = new Map();
  for (const t of unpinned) unique.set(`${t.ownerAction}@${t.ref}`, t);

  const byFile = new Map();
  for (const t of unpinned) {
    if (!byFile.has(t.file)) byFile.set(t.file, []);
    // One entry per distinct reference per file. `actions/checkout@v5` appears
    // three times in ci.yml, and the replacement below is `split().join()`, which
    // rewrites all three at once - so a second entry for the same reference would
    // then fail its own presence check.
    const list = byFile.get(t.file);
    if (!list.some((e) => e.ownerAction === t.ownerAction && e.ref === t.ref)) {
      list.push(t);
    }
  }

  // The resolved SHA, keyed by reference.
  //
  // Held in a map rather than on the per-occurrence objects, because the same
  // reference appears several times in a file (`actions/checkout@v5` is used
  // three times in ci.yml) and only the deduped entries get resolved. Reading
  // `t.sha` off a per-file entry is therefore `undefined` for every duplicate,
  // which writes `@undefined # v5` into the workflow - a worse outcome than not
  // running the tool at all.
  const shaByRef = new Map();
  const errorByRef = new Map();
  const cache = readCache();

  for (const [, t] of unique) {
    const [owner, action] = t.ownerAction.split("/");
    const r = await resolveSha(owner, action, t.ref, cache);
    if (r.ok) shaByRef.set(`${t.ownerAction}@${t.ref}`, r.sha);
    else errorByRef.set(`${t.ownerAction}@${t.ref}`, r.status);
  }

    const resolved = shaByRef.size;
  const failed = errorByRef.size;

  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // A cache is an optimisation. Failing to write one is not a failure.
  }

  for (const [file, entries] of byFile) {
    console.log(`  ${file}`);
    for (const t of entries) {
      const sha = shaByRef.get(`${t.ownerAction}@${t.ref}`);
      const target = sha ? sha : `UNRESOLVED (${errorByRef.get(`${t.ownerAction}@${t.ref}`)})`;
      console.log(`    ${t.ownerAction}@${t.ref} -> ${target}`);
    }
  }

  console.log(`\n  resolved ${resolved}, unresolved ${failed}`);

  if (!WRITE) {
    console.log("\nDry run. Re-run with --write to rewrite the workflow files.");
    if (failed > 0) {
      console.log("Unresolved references need a manual SHA - an annotated tag, or no network.");
    }
    return;
  }

  if (failed > 0) {
    console.error(
      "\nRefusing to write with unresolved references: a partially pinned workflow is\n" +
        "worse than an unpinned one, because the diff suggests it was done deliberately.\n" +
        "Resolve them by hand, or re-run with network access."
    );
    process.exit(1);
  }

  for (const [file, entries] of byFile) {
    const abs = path.join(WORKFLOWS, path.basename(file));
    let text = fs.readFileSync(abs, "utf8");
    for (const t of entries) {
      // Looked up by reference, not read off the entry: `actions/checkout@v5`
      // appears three times in ci.yml, and only the deduped entry is the same
      // object as the one that was resolved.
      const sha = shaByRef.get(`${t.ownerAction}@${t.ref}`);
      const from = `${t.ownerAction}@${t.ref}`;
      const to = `${from.replace(`@${t.ref}`, "")}@${sha} # ${t.ref}`;
      if (!text.includes(from)) {
        console.error(`  race: ${from} no longer present in ${file}`);
        process.exit(1);
      }
      if (!sha) {
        console.error(`  no SHA resolved for ${from}`);
        process.exit(1);
      }
      text = text.split(from).join(to);
    }
    fs.writeFileSync(abs, text);
    console.log(`  wrote ${file}`);
  }

  console.log("\nPinned. Add the github-actions ecosystem to dependabot so these stay current.");
})();