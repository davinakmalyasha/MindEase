// Proves check-stale-writes.js can fail, by reverting each mechanism it looks for.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const GATE = path.join(ROOT, "scripts", "check-stale-writes.js");

const BRIEFING = "client/app/dashboard/briefing/[appointmentId]/page.tsx";
const PRESESSION = "client/app/dashboard/pre-session/[appointmentId]/page.tsx";
const DOCTORS = "client/app/doctors/page.tsx";

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

function run(overrides, extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-"));
    const real = { [BRIEFING]: BRIEFING, [PRESESSION]: PRESESSION, [DOCTORS]: DOCTORS };
    for (const f of Object.values(real)) {
        const dest = path.join(dir, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const content = overrides[f] !== undefined ? overrides[f] : fs.readFileSync(path.join(ROOT, f), "utf8");
        fs.writeFileSync(dest, content, "utf8");
    }
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.copyFileSync(GATE, path.join(dir, "scripts", "check-stale-writes.js"));
    const res = spawnSync(process.execPath, ["scripts/check-stale-writes.js"], { cwd: dir, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

console.log("--- the current tree passes ---");
{
    const r = run({});
    if (r.code === 0) ok("accepts the current tree");
    else bad("accepts the current tree", r.out.slice(0, 400));
}

console.log("\n--- it rejects a page with no staleness guard ---");
{
    const src = fs.readFileSync(path.join(ROOT, BRIEFING), "utf8");
    // Strip the mechanism, leaving the rest of the component intact.
    const stripped = src
        .replace(/requestSeq\.current/g, "0")
        .replace(/if \(seq !== 0\) return;\s*/g, "")
        .replace(/return \(\) => \{\s*0\s*\+=\s*1;\s*\};/, "");
    const r = run({ [BRIEFING]: stripped });
    if (r.code !== 0 && /stale response/i.test(r.out)) ok("rejects a page that can write out of order");
    else bad("rejects a page that can write out of order", `exit=${r.code}`);
}

console.log("\n--- it rejects a cursor that advances on failure ---");
{
    const src = fs.readFileSync(path.join(ROOT, DOCTORS), "utf8");
    const regressed = src
        .replace("if (await loadPage(next)) setPage(next);", "await loadPage(next); setPage(next);")
        .replace(/const loadPage = async \([^)]*\)\s*:\s*Promise<boolean>/, "const loadPage = async (targetPage: number)");
    const r = run({ [DOCTORS]: regressed });
    if (r.code !== 0 && /cursor advances only on success/i.test(r.out))
        ok("rejects an unconditional page advance");
    else bad("rejects an unconditional page advance", `exit=${r.code}, ${r.out.slice(0, 200)}`);
}

console.log("\n--- it rejects a failure reported as an empty result ---");
{
    const src = fs.readFileSync(path.join(ROOT, DOCTORS), "utf8");
    const regressed = src.replace("setAiFailed(true);\n            setAiMatches(null);", "setAiMatches([]);");
    const r = run({ [DOCTORS]: regressed });
    if (r.code !== 0 && /failed AI match stays distinct/i.test(r.out))
        ok("rejects a failed match rendered as zero matches");
    else bad("rejects a failed match rendered as zero matches", `exit=${r.code}`);
}

console.log(`\ncheck-stale-writes self-test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);