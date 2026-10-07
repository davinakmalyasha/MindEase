// Proves the new gate can fail, by breaking each defect it looks for.
//
// A gate that has only ever passed is indistinguishable from a gate that cannot
// fail. These cases reconstruct the original bugs against the real files and
// assert the checker rejects each one.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const GATE = path.join(ROOT, "scripts", "check-load-states.js");
const ORIGIN = "https://github.com/davinakmalyasha/MindEase.git";
const SHA = process.argv[2] || "HEAD";

// The committed tree, which is the pre-fix state for this pass.
function gitShow(file) {
    return execFileSync("git", ["show", `${SHA}:${file}`], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
    });
}

// The working tree, which holds the fixes being tested.
function worktree(file) {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
}

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

// Materialise a one-file repository containing the pre-fix version of a
// component plus the gate, and run the gate inside it.
function runGateAgainst(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadstate-"));
    for (const [rel, content] of Object.entries(files)) {
        const dest = path.join(dir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content, "utf8");
    }
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.copyFileSync(GATE, path.join(dir, "scripts", "check-load-states.js"));

    const res = require("child_process").spawnSync(process.execPath, ["scripts/check-load-states.js"], {
        cwd: dir,
        encoding: "utf8",
    });
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

console.log("--- the gate rejects a swallowed fetch error ---");
{
    const before = gitShow("client/app/dashboard/page.tsx");
    const res = runGateAgainst({
        "client/app/dashboard/page.tsx": before,
        "client/app/dashboard/briefing/[appointmentId]/page.tsx": 'const a = 1;\n',
        "client/app/dashboard/pre-session/[appointmentId]/page.tsx": 'const b = 1;\n',
        "client/app/dashboard/profile/page.tsx": "profileFailed\n<form",
        "client/app/doctors/[id]/page.tsx": "loadFailed\n",
        "client/components/doctors/DoctorProfile.tsx": "packagesFailed\nloadPackages\n",
    });
    if (res.code !== 0 && /swallow/i.test(res.out)) ok("rejects the pre-fix dashboard");
    else bad("rejects the pre-fix dashboard", `exit=${res.code}, out=${res.out.slice(0, 300)}`);
}

console.log("\n--- the gate accepts the fixed components ---");
{
    const files = {};
    for (const f of [
        "client/app/dashboard/page.tsx",
        "client/app/dashboard/briefing/[appointmentId]/page.tsx",
        "client/app/dashboard/pre-session/[appointmentId]/page.tsx",
        "client/app/dashboard/profile/page.tsx",
        "client/app/doctors/[id]/page.tsx",
        "client/components/doctors/DoctorProfile.tsx",
    ]) {
        files[f] = worktree(f);
    }
    const res = runGateAgainst(files);
    if (res.code === 0) ok("accepts the current tree");
    else bad("accepts the current tree", `exit=${res.code}, out=${res.out.slice(0, 400)}`);
}

console.log("\n--- the gate rejects a form rendered before its failure guard ---");
{
    const res = runGateAgainst({
        "client/app/dashboard/page.tsx": "statsFailed loadingStats ErrorState LoadingState\n",
        "client/app/dashboard/briefing/[appointmentId]/page.tsx": "loadFailed reload 404\n",
        "client/app/dashboard/pre-session/[appointmentId]/page.tsx": "loadFailed 404\n",
        // The guard appears *after* the form in source order.
        "client/app/dashboard/profile/page.tsx": "<form>handleSubmit</form>\nprofileFailed) {\n",
        "client/app/doctors/[id]/page.tsx": "loadFailed\n",
        "client/components/doctors/DoctorProfile.tsx": "packagesFailed loadPackages\n",
    });
    if (res.code !== 0 && /blocks the form/i.test(res.out)) ok("rejects a form that opens before it has loaded");
    else bad("rejects a form that opens before it has loaded", `exit=${res.code}`);
}

console.log("\n--- the gate ignores the anti-pattern inside comments ---");
{
    const res = runGateAgainst({
        "client/app/dashboard/page.tsx": "statsFailed loadingStats ErrorState LoadingState\n",
        "client/app/dashboard/briefing/[appointmentId]/page.tsx": "loadFailed reload 404\n",
        "client/app/dashboard/pre-session/[appointmentId]/page.tsx": "loadFailed 404\n",
        "client/app/dashboard/profile/page.tsx": "profileFailed) {\n<form",
        "client/app/doctors/[id]/page.tsx": "loadFailed\n",
        "client/components/doctors/DoctorProfile.tsx":
            "packagesFailed loadPackages\n// the previous `.catch(() => {})` hid this\n/* .catch(() => null) too */\n",
    });
    if (res.code === 0) ok("does not read its own documentation as a defect");
    else bad("does not read its own documentation as a defect", `exit=${res.code}, out=${res.out.slice(0, 300)}`);
}

console.log(`\ncheck-load-states self-test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);