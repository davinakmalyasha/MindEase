// Pins the rule that a foreign-key column with no declared index must be
// acknowledged.
//
// The failure this exists to prevent is the one that just happened: `Review.userId`
// was documented as "currently scanned", when InnoDB had been indexing it the
// whole time under the name `Review_userId_fkey`. A gate that had existed would
// not have prevented the mistake - the mistake was an assumption about the
// database, and this gate's contribution is making the assumption explicit rather
// than implicit. So the cases below are about the parser and the bookkeeping,
// which are the parts that can rot silently.

const assert = require("assert");

const { findUndeclared, ACKNOWLEDGED } = require("./check-schema-indexes.js");

const cases = [
  {
    name: "a relation with no index is reported",
    src: `model Widget {
  id     Int @id @default(autoincrement())
  userId Int
  user   User @relation(fields: [userId], references: [id], onDelete: Cascade)
}`,
    want: ["Widget.userId"],
  },
  {
    name: "a relation whose column leads an @@index is not reported",
    src: `model Widget {
  id     Int @id @default(autoincrement())
  userId Int
  user   User @relation(fields: [userId], references: [id])
  @@index([userId, createdAt])
}`,
    want: [],
  },
  {
    name: "a relation whose column is in a @@unique is not reported",
    src: `model Widget {
  id     Int @id @default(autoincrement())
  userId Int  @unique
  user   User @relation(fields: [userId], references: [id])
}`,
    want: [],
  },
  {
    name: "a composite index only covers its leading column",
    // `@@index([createdAt, userId])` does not help a `WHERE userId = ?` lookup,
    // so this must still be reported. The converse mistake - treating any
    // mention of a column as an index - is the one that would hide a real gap.
    src: `model Widget {
  id        Int @id @default(autoincrement())
  userId    Int
  createdAt DateTime @default(now())
  user      User @relation(fields: [userId], references: [id])
  @@index([createdAt, userId])
}`,
    want: ["Widget.userId"],
  },
  {
    name: "two foreign keys in one relation",
    src: `model Link {
  id     Int @id @default(autoincrement())
  fromId Int
  toId   Int
  from   User   @relation(fields: [fromId], references: [id], onDelete: Cascade)
  to     Doctor @relation(fields: [toId], references: [id], onDelete: Cascade)
}`,
    want: ["Link.fromId", "Link.toId"],
  },
];

let failed = 0;

for (const c of cases) {
  try {
    const got = Object.keys(findUndeclared(c.src)).sort();
    assert.deepStrictEqual(got, [...c.want].sort());
    console.log(`ok   ${c.name} (${got.length})`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${c.name}`);
    console.error(`     ${e.message}`);
  }
}

// The bookkeeping cases: a missing acknowledgement and a stale one.
//
// Both read the real schema. Note the presence check rather than a truthiness
// test: `findUndeclared` maps each key to `""`, and the first version of this
// block used `!real[k]`, which is true for every key in the object and so
// reported all five as stale. A test that fails on correct input gets deleted,
// and this one would have been deleted for being wrong.
const fs = require("fs");
const path = require("path");

const SCHEMA = path.join(__dirname, "..", "server", "prisma", "schema.prisma");
const real = findUndeclared(fs.readFileSync(SCHEMA, "utf8"));

{
  const unacknowledged = Object.keys(real).filter((k) => !(k in ACKNOWLEDGED));
  try {
    assert.deepStrictEqual(unacknowledged, []);
    console.log("ok   every real undeclared foreign key is acknowledged");
  } catch (e) {
    failed += 1;
    console.error("FAIL some foreign keys are unacknowledged:");
    console.error(`     ${unacknowledged.join(", ")}`);
  }
}

{
  const stale = Object.keys(ACKNOWLEDGED).filter((k) => !(k in real));
  try {
    assert.deepStrictEqual(stale, []);
    console.log("ok   no acknowledgement refers to a column that no longer needs one");
  } catch (e) {
    failed += 1;
    console.error("FAIL stale acknowledgements:");
    console.error(`     ${stale.join(", ")}`);
  }
}

if (failed) {
  console.error(`\n${failed} of ${cases.length + 2} case(s) failed.`);
  process.exit(1);
}
console.log(`\ncheck-schema-indexes self-test: ${cases.length + 2} cases passed.`);