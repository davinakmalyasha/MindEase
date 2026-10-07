// Proves check-read-audit.js can fail, and that it can tell a real gap from a
// method it simply failed to parse.
//
// The second half matters more than the first. An earlier version of the method
// extractor took the first `{` after the method name, which lands inside a
// default-value object literal or a `Promise<{...}>` return type - so it reported
// three correctly instrumented methods as unlogged. A checker that cries wolf on
// correct code gets switched off, and then the gap it was written to catch is
// open with nothing watching.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const GATE = path.join(ROOT, "scripts", "check-read-audit.js");

const FILES = [
    "server/src/services/audit.service.ts",
    "server/src/services/riskQueue.service.ts",
    "server/src/services/preSession.service.ts",
    "server/src/services/message.service.ts",
    "server/src/services/carePlan.service.ts",
    "server/src/controllers/admin.controller.ts",
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readaudit-"));
    for (const f of FILES) {
        const dest = path.join(dir, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const override = overrides?.[f];
        fs.writeFileSync(
            dest,
            override !== undefined ? override : fs.readFileSync(path.join(ROOT, f), "utf8"),
            "utf8"
        );
    }
    // Stages the gate with `scripts/lib/` beside it, so the shared helper
    // resolves exactly as it does in the repository.
    require("../scripts/lib/method-body").stageGate(GATE, dir);
    const res = spawnSync(process.execPath, ["scripts/check-read-audit.js"], { cwd: dir, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

console.log("--- the current tree passes ---");
{
    const r = run();
    if (r.code === 0) ok("accepts the current tree");
    else bad("accepts the current tree", r.out.slice(0, 500));
}

console.log("\n--- it catches a removed audit call ---");
{
    const key = "server/src/services/riskQueue.service.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    const stripped = src.replace(/await Promise\.all\(\s*items\.map\([\s\S]*?\)\s*\);/, "");
    if (stripped === src) bad("catches a removed audit call", "could not remove the call");
    else {
        const r = run({ [key]: stripped });
        if (r.code !== 0 && /listQueue\(\) audits its read/.test(r.out))
            ok("flags the disclosure queue being read unlogged");
        else bad("flags the disclosure queue being read unlogged", `exit=${r.code}`);
    }
}

console.log("\n--- it catches a misspelled resource type ---");
{
    const key = "server/src/services/message.service.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    const typo = src.replace('subjectType: "Message"', 'subjectType: "Messages"');
    const r = run({ [key]: typo });
    if (r.code !== 0 && /subjectType/.test(r.out))
        ok("flags a resource name no query would find");
    else bad("flags a resource name no query would find", `exit=${r.code}`);
}

console.log("\n--- it catches self-service being logged as an access ---");
{
    const key = "server/src/services/carePlan.service.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    // Remove the "only if the reader is not the patient" guard.
    const regressed = src.replace(
        /if\s*\(actor\.id\s*!==\s*patientId\)\s*\{\s*await AuditService\.logRead\(/,
        "await AuditService.logRead({ /* unguarded */\n            void 0 &&"
    );
    const r = run({ [key]: regressed });
    if (r.code !== 0 && /only when the reader is not the patient/.test(r.out))
        ok("flags a patient's own record being logged as an access");
    else bad("flags a patient's own record being logged as an access", `exit=${r.code}`);
}

console.log("\n--- it catches an audit write that can reject the read ---");
{
    const key = "server/src/services/audit.service.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    const regressed = src.replace(
        /static async logRead\(entry: ReadAuditEntry\): Promise<void>\s*\{\s*try\s*\{/,
        "static async logRead(entry: ReadAuditEntry): Promise<void> {\n        if (true) {"
    );
    const r = run({ [key]: regressed });
    if (r.code !== 0 && /swallows its own failure/.test(r.out))
        ok("flags an audit failure that would deny the read");
    else bad("flags an audit failure that would deny the read", `exit=${r.code}`);
}

console.log("\n--- it catches an unlogged bulk export ---");
{
    const key = "server/src/controllers/admin.controller.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    // Drop the bookings branch's log, leaving the other two - so the failure is
    // "one branch is uncovered", not "the controller is unrecognisable".
    const stripped = src.replace(
        /\/\/ The bookings export carries[\s\S]*?await AuditService\.logBulkExport\(\{[\s\S]*?\}\);\n/,
        ""
    );
    if (stripped === src) bad("catches an unlogged export branch", "could not remove the call");
    else {
        const r = run({ [key]: stripped });
        if (r.code !== 0 && /exportCsv\(\) records/.test(r.out))
            ok("flags an export branch that returns patient data unrecorded");
        else bad("flags an export branch that returns patient data unrecorded", `exit=${r.code}`);
    }
}

console.log(`\ncheck-read-audit self-test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);