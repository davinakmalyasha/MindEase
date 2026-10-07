// A clinical read that leaves no trace.
//
// ## Why a gate rather than a test
//
// The test suite proves the audit *fires* when it is called. It cannot prove the
// call is still *there*. Every entry point here is an ordinary method body, so
// deleting the `AuditService.logRead` call leaves a green suite - the endpoint
// still returns the right data, and the audit tests still pass because they
// exercise the paths that remain instrumented.
//
// That is the same shape as the CSP incident: a security-relevant behaviour that
// nothing failed when it went missing. So this reads the source and requires the
// call to be present on every clinical read path.

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

/**
 * Every read of another person's clinical data, and the service method that
 * performs it.
 *
 * `resource` must be one of `AuditService.CLINICAL_RESOURCES`, which is checked
 * below - so a typo cannot quietly create a resource type that no query will
 * ever look for.
 */
const READ_PATHS = [
    {
        file: "server/src/services/riskQueue.service.ts",
        method: "listQueue",
        resource: "RiskAlert",
        what: "the disclosure triage queue",
    },
    {
        file: "server/src/services/preSession.service.ts",
        method: "getBriefing",
        resource: "Briefing",
        what: "mood history, screening scores and pre-session answers",
    },
    {
        file: "server/src/services/message.service.ts",
        method: "getMessages",
        resource: "Message",
        what: "a thread, which is where disclosures are written in the patient's own words",
    },
    {
        file: "server/src/services/carePlan.service.ts",
        method: "listForPatient",
        resource: "CarePlan",
        what: "a patient's care plan",
    },
    {
        file: "server/src/services/carePlan.service.ts",
        method: "get",
        resource: "SafetyPlan",
        what: "the safety plan",
    },
];

// Shared, because three copies of this had three different bugs - a brace in a
// default value, a brace in a multi-line return type, and `\r\n`. See the header of
// `scripts/lib/method-body.js`.
const { methodBody } = require("./lib/method-body");

console.log("--- every clinical read records an access entry ---");
for (const p of READ_PATHS) {
    const src = read(p.file);
    const body = methodBody(src, p.method);
    if (body === null) {
        bad(`${p.method}() audits its read`, `not found in ${p.file} - the method was renamed or moved`);
        continue;
    }
    if (!/AuditService\.logRead\s*\(/.test(body)) {
        bad(`${p.method}() audits its read`, `no logRead call - opening ${p.what} is unlogged`);
        continue;
    }
    ok(`${p.method}() audits its read`);
}

console.log("\n--- and it names the resource it is reading ---");
for (const p of READ_PATHS) {
    const src = read(p.file);
    const body = methodBody(src, p.method);
    if (!body) continue;
    // `subjectType: "X"` - the field a query looks at.
    const found = body.includes(`subjectType: "${p.resource}"`);
    if (found) ok(`${p.method}() records subjectType "${p.resource}"`);
    else bad(`${p.method}() records subjectType "${p.resource}"`, "the type is missing or misspelled");
}

console.log("\n--- the resource names are the ones the query can find ---");
// A closed list in the service, matched against the call sites. A typo here
// produces entries no query will ever return, which is an access log that
// appears to work and answers nothing.
{
    const svc = read("server/src/services/audit.service.ts");
    const declared = [...svc.matchAll(/^\s{4}"(\w+)",$/gm)].map((m) => m[1]);
    if (declared.length === 0) {
        bad("CLINICAL_RESOURCES is a closed list", "could not read it out of audit.service.ts");
    } else {
        ok(`CLINICAL_RESOURCES declares ${declared.length} resources`);
        const undeclared = READ_PATHS.filter((p) => !declared.includes(p.resource));
        if (undeclared.length === 0) ok("every audited resource is declared");
        else
            bad(
                "every audited resource is declared",
                undeclared.map((p) => p.resource).join(", ")
            );
    }
}

console.log("\n--- a patient's own record is not logged as an access ---");
// The converse. Self-service is not an access event, and a trail full of "this
// person opened their own file" is a trail nobody reads.
{
    const carePlan = read("server/src/services/carePlan.service.ts");
    const safety = methodBody(carePlan, "get");
    if (safety && /if\s*\(\s*actor\.id\s*!==\s*patientId\s*\)/.test(safety)) {
        ok("SafetyPlan.get() logs only when the reader is not the patient");
    } else {
        bad("SafetyPlan.get() logs only when the reader is not the patient", "no actor/patient guard");
    }

    const list = methodBody(carePlan, "listForPatient");
    if (list && /if\s*\(\s*actor\s*&&\s*actor\.id\s*!==\s*patientId\s*\)/.test(list)) {
        ok("CarePlan.listForPatient() logs only when the reader is not the patient");
    } else {
        bad("CarePlan.listForPatient() logs only when the reader is not the patient", "no actor/patient guard");
    }
}

console.log("\n--- a bulk export is recorded as an event ---");
{
    // An administrator exporting the user table is the largest single access
    // event in the product. It is recorded once, naming the actor, the dataset
    // and the row count - not once per subject, because attributing a
    // ten-thousand-row export to each patient on it would be write amplification
    // and would produce a trail nobody can read.
    const admin = read("server/src/controllers/admin.controller.ts");
    const body = methodBody(admin, "exportCsv");
    if (!body) {
        bad("exportCsv() records the export", "not found");
    } else {
        const calls = (body.match(/AuditService\.logBulkExport\(/g) || []).length;
        // One per dataset branch: users, revenue, bookings.
        if (calls >= 3) ok(`exportCsv() records all ${calls} dataset branches`);
        else bad("exportCsv() records every dataset branch", `only ${calls} logBulkExport call(s) for 3 branches`);
    }

    const svc = read("server/src/services/audit.service.ts");
    if (/static async logBulkExport\(/.test(svc)) ok("AuditService.logBulkExport exists");
    else bad("AuditService.logBulkExport exists", "not found");
}

console.log("\n--- an audit failure cannot deny the read ---");
{
    const svc = read("server/src/services/audit.service.ts");
    const body = methodBody(svc, "logRead");
    if (!body) {
        bad("logRead swallows its own failure", "not found");
    } else if (/try\s*\{/.test(body) && /catch\s*\(/.test(body)) {
        ok("logRead swallows its own failure");
    } else {
        bad("logRead swallows its own failure", "no try/catch - a failed write would propagate to the read");
    }
}

console.log(`\ncheck-read-audit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);