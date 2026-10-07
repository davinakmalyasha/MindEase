// Proves check-auth-coverage.js can fail, including on the exact leak it exists for.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const GATE = path.join(ROOT, "scripts", "check-auth-coverage.js");
const ROUTES = path.join(ROOT, "server", "src", "routes");
const SERVICES = path.join(ROOT, "server", "src", "services");

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "authcov-"));
    const copy = (from, to) => {
        fs.mkdirSync(to, { recursive: true });
        for (const e of fs.readdirSync(from, { withFileTypes: true })) {
            const s = path.join(from, e.name);
            const d = path.join(to, e.name);
            if (e.isDirectory()) copy(s, d);
            else {
                const key = path.relative(ROOT, s).replace(/\\/g, "/");
                const override = overrides?.[key];
                fs.writeFileSync(d, override !== undefined ? override : fs.readFileSync(s, "utf8"), "utf8");
            }
        }
    };
    copy(ROUTES, path.join(dir, "server", "src", "routes"));
    copy(SERVICES, path.join(dir, "server", "src", "services"));
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.copyFileSync(GATE, path.join(dir, "scripts", "check-auth-coverage.js"));
    const res = spawnSync(process.execPath, ["scripts/check-auth-coverage.js"], { cwd: dir, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

console.log("--- the current tree is clean ---");
{
    const r = run();
    if (r.code === 0) ok("reports no unguarded route");
    else bad("reports no unguarded route", r.out.slice(0, 500));
}

console.log("\n--- it catches the reviewer-identity leak it was written for ---");
{
    const key = "server/src/services/review.service.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    // Put the original `include: { user: { select: { name, avatar } } }` back.
    // Anchored on the call, because an unanchored `replace` takes the first
    // matching block in the file and there are several other selects with a
    // `userId: true` in them - the first attempt silently rewrote the wrong
    // query and the gate correctly reported nothing.
    const regressed = src.replace(
        /(prisma\.review\.findMany\(\{[\s\S]*?)select: \{[^}]*userId: true,[^}]*\}/,
        '$1include: { user: { select: { id: true, name: true, avatar: true } } }'
    );
    if (regressed === src) {
        bad("catches the reviewer-identity leak", "could not reconstruct the pre-fix query");
    } else {
        const r = run({ [key]: regressed });
        if (r.code !== 0 && /LEAK/.test(r.out)) ok("flags a public route that selects a reviewer's name");
        else bad("flags a public route that selects a reviewer's name", `exit=${r.code}, ${r.out.slice(0, 300)}`);
    }
}

console.log("\n--- it catches a route that drops its guard ---");
{
    const key = "server/src/routes/wellness.routes.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    const regressed = src.replace(/router\.use\(authenticate\)/, "router.use()");
    const r = run({ [key]: regressed });
    if (r.code !== 0 && /UNGUARDED/.test(r.out)) ok("flags a route whose router-level guard was removed");
    else bad("flags a route whose router-level guard was removed", `exit=${r.code}`);
}

console.log("\n--- it catches an inline guard being deleted ---");
{
    const key = "server/src/routes/admin.routes.ts";
    const src = fs.readFileSync(path.join(ROOT, key), "utf8");
    const regressed = src.replace("router.use(authenticate, requireAdmin);", "");
    const r = run({ [key]: regressed });
    if (r.code !== 0 && /UNGUARDED/.test(r.out))
        ok("flags twelve admin endpoints when requireAdmin is dropped");
    else bad("flags twelve admin endpoints when requireAdmin is dropped", `exit=${r.code}`);
}

console.log(`\ncheck-auth-coverage self-test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);