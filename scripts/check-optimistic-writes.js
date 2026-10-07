// Optimistic concurrency on the patient-owned plan documents.
//
// ## Why this is a source check and not only a test
//
// `plan-concurrency.test.ts` proves the *behaviour*: a stale save returns 409 and
// the write does not happen. What it cannot prove is that a future refactor keeps
// the mechanism. The failure mode is specific and quiet - someone replaces
//
//     updateMany({ where: { id, version: expected }, ... })
//
// with the more obvious
//
//     update({ where: { id }, ... })
//
// and every concurrency test starts passing again for the wrong reason: a
// check-then-write still returns 409 when the version is checked *before* the
// write, and only two truly simultaneous writers expose the difference. That is a
// race, so a serial test suite will usually miss it.
//
// The conditional `where` is the whole fix. So it is checked as syntax.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
let fail = 0;
const ok = (n) => {
    console.log(`ok   ${n}`);
    pass += 1;
};
const bad = (n, why) => {
    console.log(`FAIL ${n}\n       ${why}`);
    fail += 1;
};

/** The body of one static method, skipping the signature's own braces. */
function methodBody(src, name) {
    const start = src.search(new RegExp(`static\\s+(async\\s+)?${name}\\s*\\(`));
    if (start === -1) return null;

    const paren = src.indexOf("(", start);
    if (paren === -1) return null;
    let pdepth = 0;
    let close = -1;
    for (let i = paren; i < src.length; i += 1) {
        if (src[i] === "(") pdepth += 1;
        else if (src[i] === ")") {
            pdepth -= 1;
            if (pdepth === 0) {
                close = i;
                break;
            }
        }
    }
    if (close === -1) return null;

    const isBreak = (c) => c === "\n" || c === "\r";
    let open = -1;
    for (let i = close; i < src.length; i += 1) {
        if (src[i] === "{" && isBreak(src[i + 1])) {
            open = i;
            break;
        }
    }
    if (open === -1) open = src.indexOf("{", close);
    if (open === -1) return null;

    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
        if (src[i] === "{") depth += 1;
        else if (src[i] === "}") {
            depth -= 1;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    return null;
}

console.log("--- both documents carry a version column ---");
{
    const schema = read("server/prisma/schema.prisma");
    for (const model of ["CarePlan", "SafetyPlan"]) {
        // The model block, from `model X {` to the closing brace.
        const at = schema.search(new RegExp(`model\\s+${model}\\s*\\{`));
        const block = at === -1 ? "" : schema.slice(at, schema.indexOf("\n}", at) + 2);
        if (/version\s+Int\s+@default\(0\)/.test(block)) {
            ok(`${model}.version exists and is NOT NULL with a default`);
        } else if (/version\s+Int\?/.test(block)) {
            bad(`${model}.version is NOT NULL`, "nullable version - the guard would apply only when data happens to be present");
        } else {
            bad(`${model}.version exists and is NOT NULL with a default`, "not found");
        }
    }
}

console.log("\n--- the content write is conditional on the version ---");
{
    const svc = read("server/src/services/carePlan.service.ts");

    const updatePlan = methodBody(svc, "updatePlan");
    if (!updatePlan) bad("updatePlan() is findable", "not found");
    else {
        if (/prisma\.carePlan\.updateMany\(/.test(updatePlan)) {
            ok("updatePlan() writes through updateMany, which can carry a non-unique where");
        } else {
            bad("updatePlan() writes through updateMany, which can carry a non-unique where",
                "uses create/update/upsert - Prisma's update takes a unique where and cannot express 'and the version still matches'");
        }
        if (/where:\s*\{[^}]*version:/.test(updatePlan)) {
            ok("updatePlan() matches on the version inside the write");
        } else {
            bad("updatePlan() matches on the version inside the write", "no `version:` in the update's where - check-then-write is back");
        }
    }

    const save = methodBody(svc, "save");
    if (!save) bad("SafetyPlan.save() is findable", "not found (the method name changed)");
    else {
        if (/prisma\.safetyPlan\.updateMany\(/.test(save)) {
            ok("SafetyPlan.save() writes through updateMany");
        } else {
            bad("SafetyPlan.save() writes through updateMany", "not found");
        }
        if (/where:\s*\{[^}]*version:/.test(save)) {
            ok("SafetyPlan.save() matches on the version inside the write");
        } else {
            bad("SafetyPlan.save() matches on the version inside the write", "no `version:` in the update's where");
        }
    }
}

console.log("\n--- a partial save still only writes the keys it was sent ---");
{
    // The concurrency change replaced an `upsert` whose update branch carried the
    // merge behaviour. A rewrite that ignores `undefined` and writes every field
    // would restore the original data-loss bug: editing one section erases five.
    const svc = read("server/src/services/carePlan.service.ts");
    const save = methodBody(svc, "save");
    if (save && /!== undefined\)\s*data\.\w+\s*=/.test(save)) {
        ok("SafetyPlan.save() keeps 'only the keys the caller sent'");
    } else {
        bad("SafetyPlan.save() keeps 'only the keys the caller sent'",
            "the `undefined` guards are gone - a partial save would null the rest");
    }
}

console.log("\n--- the care plan schema requires a version ---");
{
    const schema = read("server/src/schemas/carePlan.schema.ts");
    const at = schema.indexOf("UpdateCarePlanSchema");
    const block = at === -1 ? "" : schema.slice(at, schema.indexOf("});", at));
    if (/version:\s*z\.coerce\.number\(\)\.int\(\)\.min\(0\),/.test(block)) {
        ok("UpdateCarePlanSchema.version is required");
    } else if (/version:[\s\S]*?\.optional\(\)/.test(block)) {
        bad("UpdateCarePlanSchema.version is required",
            "optional - an un-updated client would keep overwriting silently, which is the bug");
    } else {
        bad("UpdateCarePlanSchema.version is required", "not found");
    }
}

console.log("\n--- the client sends the version it was shown, and handles the refusal ---");
{
    const page = read("client/app/dashboard/safety-plan/page.tsx");

    if (/api\.put\("\/safety-plan",\s*\{\s*\.\.\.d,\s*version\s*\}/.test(page)) {
        ok("the safety plan save sends `version` with the draft");
    } else {
        bad("the safety plan save sends `version` with the draft", "the body does not include version");
    }

    if (/status\s*===\s*409/.test(page)) {
        ok("a 409 is recognised as a conflict rather than a generic failure");
    } else {
        bad("a 409 is recognised as a conflict rather than a generic failure", "no status check for 409");
    }

    // A conflict must be durable on the page, not a toast that leaves an
    // editable form over a version that no longer exists.
    if (/role="alert"/.test(page) && /conflict/.test(page)) {
        ok("the conflict is rendered as a persistent alert");
    } else {
        bad("the conflict is rendered as a persistent alert", "no alert bound to the conflict state");
    }

    // After a successful save the version must advance, or the *next* save
    // conflicts with its own previous write.
    if (/setVersion\(saved\.version\)/.test(page)) {
        ok("the version advances after a successful save");
    } else {
        bad("the version advances after a successful save",
            "the second save would send the version the first save already replaced");
    }
}

console.log("\n--- a one-time code is spent with a compare-and-swap ---");
{
    // Same class as the plan version, different field: the consume is only
    // one-time if the write is conditional on the value that was verified.
    // Without it, two requests racing one code both verify and both write an
    // array computed before either write, so both are admitted.
    const svc = read("server/src/services/twoFactor.service.ts");
    const body = methodBody(svc, "consumeBackupCode");
    if (!body) {
        bad("consumeBackupCode() is findable", "not found");
    } else {
        if (/prisma\.user\.updateMany\(/.test(body)) {
            ok("consumeBackupCode() writes through updateMany, which can carry a non-unique where");
        } else {
            bad(
                "consumeBackupCode() writes through updateMany, which can carry a non-unique where",
                "uses update(), which matches by id alone - a concurrent spend would be lost"
            );
        }
        if (/where:\s*\{[^}]*backupCodes:/.test(body)) {
            ok("consumeBackupCode() matches on the stored set inside the write");
        } else {
            bad(
                "consumeBackupCode() matches on the stored set inside the write",
                "no `backupCodes:` in the update's where - the CAS is gone"
            );
        }
        if (/claimed\.count\s*===\s*1/.test(body)) {
            ok("consumeBackupCode() checks that its write won");
        } else {
            bad("consumeBackupCode() checks that its write won", "the result of the conditional write is discarded");
        }
    }
}

console.log("\n--- a counter is never decremented unconditionally ---");
{
    // The general form of two bugs found by reading rather than by running: a
    // package session and a referral credit are both read ("has some left?") and
    // then decremented by id. Two concurrent spends both read the same value and
    // both decrement, so one unit of entitlement covers two bookings and the
    // counter goes negative - which nothing in the schema prevents.
    //
    // The booking path got this right from the start; the follow-up path drifted
    // from it. So this is checked everywhere rather than at one call site.
    const files = [
        "server/src/services/appointment.service.ts",
        "server/src/services/followUp.service.ts",
        "server/src/services/payment.service.ts",
        "server/src/services/doctor.service.ts",
    ];

    let offenders = 0;
    let checked = 0;
    for (const file of files) {
        const src = read(file);
        for (const m of src.matchAll(/(\w+):\s*\{\s*decrement:\s*1\s*\}/g)) {
            checked += 1;
            const field = m[1];
            // The call this decrement belongs to, and the guard it carries.
            const before = src.slice(Math.max(0, m.index - 700), m.index);

            const viaUpdateMany = /updateMany\(\s*\{[\s\S]*$/.test(before);
            const guarded = new RegExp(`${field}\\s*:\\s*\\{\\s*(gt|gte)\\b`).test(before);

            if (!viaUpdateMany || !guarded) {
                offenders += 1;
                const line = src.slice(0, m.index).split("\n").length;
                console.log(
                    `FAIL ${file}:${line} decrements \`${field}\` without a guard` +
                        (viaUpdateMany ? "" : " (uses update(), which matches by id alone)")
                );
            }
        }
    }

    if (offenders === 0) ok(`all ${checked} counter decrements are conditional`);
    else fail += offenders;
}

console.log("\n--- a lifecycle transition is claimed, not assigned ---");
{
    // `updateStatus` read the appointment, validated the move, then wrote the new
    // status by id. Two concurrent cancels both passed the validation and both
    // wrote - so the slot was released twice, the waitlist was notified twice,
    // and the package session was refunded twice. One cancellation, two refunds.
    const src = read("server/src/services/appointment.service.ts");
    const body = methodBody(src, "updateStatus");
    if (!body) {
        bad("updateStatus() is findable", "not found");
    } else {
        if (/prisma\.appointment\.updateMany\(\{[\s\S]*?where:\s*\{[^}]*status:/.test(body)) {
            ok("updateStatus() claims the transition conditionally");
        } else {
            bad(
                "updateStatus() claims the transition conditionally",
                "no `status:` in an updateMany where - two concurrent transitions would both run their side effects"
            );
        }
        if (/claimed\.count\s*!==\s*1/.test(body)) {
            ok("updateStatus() checks that its claim won");
        } else {
            bad("updateStatus() checks that its claim won", "the claim's result is discarded");
        }
    }
}

console.log("\n--- a shared room identity is claimed once, not generated per caller ---");
{
    // The video room name derives from `roomSeed`, and the two participants
    // reach `joinRoom` independently. Both read `roomSeed: null`, both generated
    // a seed, and both wrote - so each kept its own value in memory and the two
    // were issued tokens for different rooms. It presents as "the other person
    // never joined", and it is unfalsifiable from either side.
    const src = read("server/src/services/appointment.service.ts");
    const body = methodBody(src, "ensureRoomSeed");
    if (!body) {
        bad("ensureRoomSeed() is findable", "not found - the join path may mint the seed inline again");
    } else {
        if (/updateMany\(/.test(body) && /where:\s*\{[^}]*roomSeed:\s*null/.test(body)) {
            ok("ensureRoomSeed() claims the column only while it is empty");
        } else {
            bad(
                "ensureRoomSeed() claims the column only while it is empty",
                "the seed is written unconditionally, so two callers can each keep their own"
            );
        }
        if (/findUniqueOrThrow\(/.test(body) && /return[\s\S]*roomSeed/.test(body)) {
            ok("ensureRoomSeed() reads back the persisted value and returns it");
        } else {
            bad(
                "ensureRoomSeed() reads back the persisted value and returns it",
                "the caller may return a seed that was overwritten in the database"
            );
        }
    }
}

console.log(`\ncheck-optimistic-writes: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);