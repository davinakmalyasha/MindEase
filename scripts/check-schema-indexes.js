// Requires every foreign-key column without a declared `@@index` to be
// acknowledged, with a reason.
//
// ## Why this exists
//
// `ENGINEERING-NOTES.md` listed, as a known problem:
//
//     3. Add the missing `@@index` on `Review.userId`, which is on the
//        account-deletion path and currently scanned.
//
// `Review.userId` is not unindexed and is not scanned. InnoDB creates an index
// for every foreign key, and this one is called `Review_userId_fkey`:
//
//     PRIMARY                             id
//     Review_appointmentId_key            appointmentId
//     Review_doctorId_hidden_createdAt_idx doctorId, hidden, createdAt
//     Review_userId_fkey                  userId      <-- created by InnoDB
//
// So the claim in the notes was false, and it was false in the way that costs
// the most: it read like a performance bug, and the two available responses were
// both wrong - add a redundant index, or leave a false statement in the
// documentation that the next person trusts.
//
// The query is not slow. The problem is that the schema does not say why it is
// not slow, so it looks like an oversight - and there are eleven of these across
// nine models.
//
// ## What this gate does
//
// It forces the decision to be written down. A foreign-key column with no
// declared index must appear in `ACKNOWLEDGED` below with a reason, or this
// fails. Adding a new relation therefore forces somebody to decide whether it
// needs an index, rather than leaving the question open indefinitely.
//
// It does not assert that any of these are fast. It asserts that the reasoning
// is written down and can be reviewed.

const fs = require("fs");
const path = require("path");

const SCHEMA = path.join(__dirname, "..", "server", "prisma", "schema.prisma");

/**
 * Foreign-key columns with no declared index, and why that is acceptable.
 *
 * Each of these is covered by an InnoDB-created index for the foreign key, so
 * the query is not a full table scan. The reason is written per entry rather than
 * stated once at the top, because the question worth asking is not "is it
 * indexed" but "is *this* the access pattern that needs a *composite* index
 * instead", and that differs per column.
 *
 * Six candidates were removed from this list after `declaredIndexes` was taught
 * to recognise an inline `@unique`: `Doctor.userId`, `SafetyPlan.userId`,
 * `PreSessionData.appointmentId`, `PackagePurchase.purchaseId`,
 * `FollowUp.appointmentId` and `Referral.referredId` are all declared `@unique`
 * on the field, which is an index. Acknowledging them would have said "reviewed
 * and fine" about columns nobody needed to review.
 */
const ACKNOWLEDGED = {
  "FollowUp.doctorId": "Every read is `WHERE doctorId = ?` on the clinician's own list, which is served by the `doctorId, appointmentDate` composite declared on the model.",
  "PackagePurchase.packageId": "Read only as `WHERE packageId = ?` for a single package; the table is small and this is an admin path, not a user-facing one.",
  "Review.userId": "Read and deleted by `userId` on the account-deletion path, which InnoDB's FK index serves directly. Claimed as unindexed in ENGINEERING-NOTES.md, which was wrong.",
  "ReviewReport.reporterId": "Never queried on its own; reports are always fetched by `reviewId` or by `status`, both declared.",
  "WaitlistEntry.patientId": "Read by `patientId` on cancellation and by `doctorId, status` on the matching path; InnoDB's FK index covers the former.",
};

/** Parses the model blocks out of the schema. */
function parseModels(src) {
  return [...src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map(([, model, body]) => [
    model,
    body.split("\n"),
  ]);
}

/**
 * Columns already carrying an index: the leading column of an `@@index` or
 * `@@unique`, or a field with an inline `@unique` / `@id`.
 *
 * The inline attribute matters. `Doctor.userId`, `SafetyPlan.userId`,
 * `PreSessionData.appointmentId` and `PackagePurchase.purchaseId` are all
 * declared `@unique` on the field, which is a unique index in MySQL - so the
 * first version of this function, which only looked for the block form, reported
 * them as unindexed and put them in the acknowledgement list. An acknowledgement
 * for a column that does have an index is worse than no acknowledgement: it says
 * "reviewed and fine" about something nobody needed to review.
 */
function declaredIndexes(lines) {
  const declared = new Set();
  for (const line of lines) {
    const block = /@@(?:index|unique)\(\s*\[?\s*(\w+)/.exec(line);
    if (block) {
      declared.add(block[1]);
      continue;
    }
    const inline = /^\s*(\w+)\s+\w+.*?@(unique|id)\b/.exec(line);
    if (inline) declared.add(inline[1]);
  }
  return declared;
}

/** `{ "Model.column": "reason" }` for every relation field with no index. */
function findUndeclared(src) {
  const found = {};
  for (const [model, lines] of parseModels(src)) {
    const declared = declaredIndexes(lines);
    for (const line of lines) {
      const m = /^\s*\w+\s+\w+\s+@relation\([^)]*fields:\s*\[([^\]]+)\]/.exec(line);
      if (!m) continue;
      for (const raw of m[1].split(",")) {
        const fk = raw.trim();
        if (!declared.has(fk)) found[`${model}.${fk}`] = "";
      }
    }
  }
  return found;
}

module.exports = { findUndeclared, declaredIndexes, parseModels, ACKNOWLEDGED };

if (require.main === module) {
  const src = fs.readFileSync(SCHEMA, "utf8");
  const found = findUndeclared(src);
  const problems = [];

  for (const key of Object.keys(found)) {
    if (!(key in ACKNOWLEDGED)) {
      problems.push(
        `${key} is a foreign key with no @@index and no acknowledgement.\n` +
          "      Either declare an index, or add it to ACKNOWLEDGED in " +
          "scripts/check-schema-indexes.js with a reason."
      );
    }
  }

  // The reverse direction: an acknowledgement for something that no longer
  // applies. A stale entry is worse than a missing one, because it reads as
  // current coverage of a column someone may have since changed.
  for (const key of Object.keys(ACKNOWLEDGED)) {
    if (!(key in found)) {
      problems.push(
        `ACKNOWLEDGED lists ${key}, which is no longer a foreign key without a declared index. ` +
          "Remove it, or fix the schema."
      );
    }
  }

  if (problems.length) {
    console.error(`check-schema-indexes found ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("");
    process.exit(1);
  }

  console.log(
    `check-schema-indexes: ${Object.keys(found).length} foreign-key columns rely on InnoDB's index, all acknowledged.`
  );
}