// Proves check-optimistic-writes.js can fail, by reverting each mechanism.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const GATE = path.join(ROOT, "scripts", "check-optimistic-writes.js");

const FILES = [
    "server/prisma/schema.prisma",
    "server/src/services/carePlan.service.ts",
    "server/src/services/appointment.service.ts",
    "server/src/services/followUp.service.ts",
    "server/src/services/payment.service.ts",
    "server/src/services/doctor.service.ts",
    "server/src/services/riskQueue.service.ts",
    "server/src/schemas/carePlan.schema.ts",
    "server/src/services/twoFactor.service.ts",
    "client/app/dashboard/safety-plan/page.tsx",
];

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

function run(overrides) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optwrite-"));
    for (const f of FILES) {
        const dest = path.join(dir, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const o = overrides?.[f];
        fs.writeFileSync(dest, o !== undefined ? o : fs.readFileSync(path.join(ROOT, f), "utf8"), "utf8");
    }
    // Stages the gate with `scripts/lib/` beside it, so the shared helper
    // resolves exactly as it does in the repository.
    require("../scripts/lib/method-body").stageGate(GATE, dir);
    const res = spawnSync(process.execPath, ["scripts/check-optimistic-writes.js"], { cwd: dir, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

console.log("--- the current tree passes ---");
{
    const r = run();
    if (r.code === 0) ok("accepts the current tree");
    else bad("accepts the current tree", r.out.slice(0, 500));
}

console.log("\n--- it catches the conditional update being replaced by a plain one ---");
{
    const f = "server/src/services/carePlan.service.ts";
    // The refactor this gate exists for: `updateMany` with a version in the where
    // becomes the more obvious `update` by id alone. Serial tests still pass.
    const regressed = src(f)
        .replace(
            /const written = await prisma\.carePlan\.updateMany\(\{\s*where: \{ id: planId, version: patch\.version \},/,
            "await prisma.carePlan.updateMany({ where: { id: planId },"
        )
        .replace(/if \(written\.count !== 1\) \{/, "if (false) {");
    if (regressed === src(f)) bad("catches a lost version guard", "could not converge the replacement");
    else {
        const r = run({ [f]: regressed });
        if (r.code !== 0 && /matches on the version inside the write/.test(r.out))
            ok("flags updatePlan no longer matching on the version");
        else bad("flags updatePlan no longer matching on the version", `exit=${r.code}`);
    }
}

console.log("\n--- it catches the client dropping the version from the save ---");
{
    const f = "client/app/dashboard/safety-plan/page.tsx";
    const regressed = src(f).replace('api.put("/safety-plan", { ...d, version })', 'api.put("/safety-plan", d)');
    if (regressed === src(f)) bad("catches a client that omits version", "could not converge the replacement");
    else {
        const r = run({ [f]: regressed });
        if (r.code !== 0 && /sends `version`/.test(r.out)) ok("flags a save body with no version");
        else bad("flags a save body with no version", `exit=${r.code}`);
    }
}

console.log("\n--- it catches a version that never advances after a save ---");
{
    const f = "client/app/dashboard/safety-plan/page.tsx";
    // The subtle one: without this the *second* save conflicts with the first.
    const regressed = src(f).replace(
        "if (saved?.version !== undefined) setVersion(saved.version);",
        "// removed"
    );
    const r = run({ [f]: regressed });
    if (r.code !== 0 && /advances after a successful save/.test(r.out))
        ok("flags a version that would conflict with its own write");
    else bad("flags a version that would conflict with its own write", `exit=${r.code}`);
}

console.log("\n--- it catches a nullable version column ---");
{
    const f = "server/prisma/schema.prisma";
    // Only the SafetyPlan one, so the CarePlan assertion still passes and the
    // failure is the one under test.
    const srcFull = src(f);
    const at = srcFull.search(/model\s+SafetyPlan\s*\{/);
    const end = srcFull.indexOf("\n}", at) + 2;
    const block = srcFull.slice(at, end);
    const swapped = block.replace("version Int @default(0)", "version Int?");
    const regressed = srcFull.slice(0, at) + swapped + srcFull.slice(end);
    const r = run({ [f]: regressed });
    if (r.code !== 0 && /NOT NULL/.test(r.out)) ok("flags a nullable version");
    else bad("flags a nullable version", `exit=${r.code}`);
}

console.log("\n--- it catches an optional version in the schema ---");
{
    const f = "server/src/schemas/carePlan.schema.ts";
    const regressed = src(f).replace(
        "version: z.coerce.number().int().min(0),",
        "version: z.coerce.number().int().min(0).optional(),"
    );
    if (regressed === src(f)) bad("catches an optional version", "could not converge the replacement");
    else {
        const r = run({ [f]: regressed });
        if (r.code !== 0 && /required/.test(r.out)) ok("flags an optional version");
        else bad("flags an optional version", `exit=${r.code}`);
    }
}

console.log("\n--- it catches the merge behaviour being dropped ---");
{
    const f = "server/src/services/carePlan.service.ts";
    // A rewrite that writes every field regardless of what was sent restores the
    // original data-loss bug: editing one section nulls the other five.
    //
    // Every guard has to go, not one of them. The first version of this case
    // replaced a single line and the gate still passed - correctly, because five
    // other `!== undefined` guards were still there. A regression case that does
    // not actually regress the behaviour proves nothing.
    const regressed = src(f).replace(/if \(\w+ !== undefined\) /g, "");
    if (!/data\.warningSigns = warningSigns;/.test(regressed)) {
        bad("flags a save that writes unmentioned keys", "could not remove the guards");
    } else {
        const r = run({ [f]: regressed });
        if (r.code !== 0 && /only the keys/.test(r.out)) ok("flags a save that writes unmentioned keys");
        else bad("flags a save that writes unmentioned keys", `exit=${r.code}`);
    }
}

console.log("\n--- it catches a one-time code that is not spent atomically ---");
{
    const key = "server/src/services/twoFactor.service.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    // The regression: the conditional updateMany becomes a plain update by id.
    // Serial reuse still fails (the code is removed), so only two simultaneous
    // spenders expose it - which is what the hardening test does.
    const regressed = src
        .replace(/const claimed = await prisma\.user\.updateMany\(\{[\s\S]*?\}\);/, "const claimed = { count: 1 };")
        .replace(
            /await prisma\.user\.updateMany\(\{[\s\S]*?\}\);/,
            "await prisma.user.update({ where: { id: userId }, data: { backupCodes: remaining.length ? JSON.stringify(remaining) : null } });"
        );
    if (regressed === src) bad("catches a lost backup-code CAS", "could not converge the replacement");
    else {
        const r = run({ [key]: regressed });
        if (r.code !== 0 && /backupCodes:/.test(r.out)) ok("flags a backup-code spend with no CAS");
        else bad("flags a backup-code spend with no CAS", `exit=${r.code}`);
    }
}

console.log("\n--- it catches an unconditional counter decrement ---");
{
    const key = "server/src/services/followUp.service.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    // The regression exactly as it was in the tree: decrement by id, no guard.
    const regressed = src.replace(
        /const claimed = await tx\.packagePurchase\.updateMany\(\{\s*where: \{ id: candidate\.id, sessionsLeft: \{ gt: 0 \} \},\s*data: \{ sessionsLeft: \{ decrement: 1 \} \},\s*\}\);/,
        "const claimed = await tx.packagePurchase.update({ where: { id: candidate.id }, data: { sessionsLeft: { decrement: 1 } } });"
    );
    if (regressed === src) bad("catches an unguarded decrement", "could not converge the replacement");
    else {
        const r = run({ [key]: regressed });
        if (r.code !== 0 && /without a guard/.test(r.out)) ok("flags a session counter decremented without a guard");
        else bad("flags a session counter decremented without a guard", `exit=${r.code}`);
    }
}

console.log("\n--- it catches an unclaimed lifecycle transition ---");
{
    const key = "server/src/services/appointment.service.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    // The regression: the conditional claim becomes an unconditional assignment.
    const regressed = src.replace(
        /const claimed = await prisma\.appointment\.updateMany\(\{\s*where: \{ id, status: appointment\.status \},\s*data: \{ status \},\s*\}\);\s*if \(claimed\.count !== 1\) \{\s*throw conflict\([^)]*\);\s*\}\s*const updated = await prisma\.appointment\.findUniqueOrThrow\(\{ where: \{ id \} \}\);/,
        "const updated = await prisma.appointment.update({ where: { id }, data: { status } });"
    );
    if (regressed === src) bad("catches an unclaimed transition", "could not converge the replacement");
    else {
        const r = run({ [key]: regressed });
        if (r.code !== 0 && /claims the transition/.test(r.out)) ok("flags a transition that assigns rather than claims");
        else bad("flags a transition that assigns rather than claims", `exit=${r.code}`);
    }
}

console.log("\n--- it catches a room seed minted per caller again ---");
{
    const key = "server/src/services/appointment.service.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    // The regression: the conditional claim inside ensureRoomSeed becomes a
    // plain write, which is what put two participants in two rooms.
    const regressed = src.replace(
        /await prisma\.appointment\.updateMany\(\{\s*where: \{ id, roomSeed: null \},\s*data: \{ roomSeed: candidate \},\s*\}\);/,
        "await prisma.appointment.update({ where: { id }, data: { roomSeed: candidate } });"
    );
    if (regressed === src) bad("catches a per-caller room seed", "could not converge the replacement");
    else {
        const r = run({ [key]: regressed });
        if (r.code !== 0 && /claims the column/.test(r.out)) ok("flags a seed written without a claim");
        else bad("flags a seed written without a claim", `exit=${r.code}`);
    }
}

console.log("\n--- it catches a triage action that assigns rather than claims ---");
{
    const key = "server/src/services/riskQueue.service.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    // The regression: resolve writes the timestamp unconditionally again, so two
    // clinicians closing the same disclosure both produce an audit entry.
    const regressed = src.replace(
        /const claimed = await prisma\.riskAlert\.updateMany\(\{\s*where: \{ id, resolvedAt: null \},/,
        "const claimed = { count: 1 }; void prisma.riskAlert.updateMany({ where: { id },"
    );
    if (regressed === src) bad("catches an unclaimed resolve", "could not converge the replacement");
    else {
        const r = run({ [key]: regressed });
        if (r.code !== 0 && /resolve\(\) claims/.test(r.out)) ok("flags a resolve with no claim");
        else bad("flags a resolve with no claim", `exit=${r.code}`);
    }
}

console.log("\n--- it catches a follow-up response that is assigned rather than claimed ---");
{
    const key = "server/src/services/followUp.service.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    const regressed = src.replace(
        /const claimed = await prisma\.followUp\.updateMany\(\{\s*where: \{ id: followUpId, status: "pending" \},\s*data: \{ status: "declined" \},\s*\}\);/,
        'const claimed = { count: 1 }; await prisma.followUp.update({ where: { id: followUpId }, data: { status: "declined" } });'
    );
    if (regressed === src) bad("catches an unclaimed decline", "could not converge the replacement");
    else {
        const r = run({ [key]: regressed });
        if (r.code !== 0 && /claims the follow-up/.test(r.out)) ok("flags a decline that assigns rather than claims");
        else bad("flags a decline that assigns rather than claims", `exit=${r.code}`);
    }
}

console.log(`\ncheck-optimistic-writes self-test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);