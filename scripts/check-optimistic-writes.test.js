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
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.copyFileSync(GATE, path.join(dir, "scripts", "check-optimistic-writes.js"));
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

console.log(`\ncheck-optimistic-writes self-test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);