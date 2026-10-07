// Authorization coverage: does every route that touches data require a caller?
//
// A missing guard is worth more than anything on the client. It is invisible in
// review, has no type error, and no failing test, because there is no test that
// asserts the absence of an endpoint.
//
// ## Two false positives this had before
//
// 1. `router.use(authenticate, requireAdmin)` applies to every route declared
//    *below* it. Reading each registration in isolation reported twelve admin
//    endpoints as unguarded - all of them behind two middlewares.
//
// 2. Middleware is frequently passed inline, and often *after* the handler name
//    in the file but *inside* the same call: `router.get("/x", rateLimit, H)`.
//    A window-based scan handles both, but only if the window is large enough
//    to include a multi-line registration.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist"].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
}

/** Middleware names that establish who the caller is. */
const AUTH = /requireAuth|authenticate|requireAdmin|requireRole|authorize|requireDoctor|requirePatient|verifyPayment|verifyWebhook|csrfProtection/;

/**
 * Routes that are deliberately reachable without a session.
 *
 * Each carries a reason, and each must name the mechanism that keeps it safe.
 * A route in this list whose data is *user-specific* has to explain why that is
 * not a disclosure - `GET /api/reviews/doctor/:doctorId` was in this list with
 * only a comment saying "public", and returned every reviewer's real name and
 * user id to anonymous callers. "It's public" describes the auth, not the risk.
 */
const PUBLIC = {
    "auth.routes.ts": "login, register, refresh, forgot-password, verify - each establishes or recovers a session",
    "health.routes.ts": "liveness and readiness probes, consumed by the platform",
    "webhook.routes.ts": "authenticated by provider signature, not by session",
    "crisis.routes.ts": "an SOS press must work signed out; creates no user data",
};

/**
 * Public routes that return per-user rows, and the field they must omit.
 *
 * Reviewed individually, because "the route needs no session" and "the route
 * may return anything" are different claims.
 */
const PUBLIC_WITH_USER_DATA = {
    "review.routes.ts": [
        {
            route: "/doctor/:doctorId",
            service: "server/src/services/review.service.ts",
            method: "getReviewsByDoctor",
            mustNotSelect: ["name: true", "avatar: true"],
            why: "reviewer identity; a pseudonym is returned instead",
        },
    ],
};

// Shared, because three copies of this had three different bugs - a brace in a
// default value, a brace in a multi-line return type, and `\r\n`. See the header of
// `scripts/lib/method-body.js`.
const { methodBody } = require("./lib/method-body");

let problems = 0;
let checked = 0;

for (const file of walk(path.join(ROOT, "server", "src", "routes"))) {
    const src = fs.readFileSync(file, "utf8");
    const base = path.basename(file);
    const lines = src.split("\n");

    // Middleware applied to the whole router, in source order. A route declared
    // before `router.use(auth)` is genuinely unguarded; one after is not.
    const routerGuards = [];
    lines.forEach((line, i) => {
        const m = line.match(/router\.use\(([^)]*)\)/);
        if (m) routerGuards.push({ line: i, args: m[1] });
    });

    lines.forEach((line, i) => {
        const m = line.match(/router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/);
        if (!m) return;
        if (PUBLIC[base]) return;

        checked += 1;

        // Cover a registration that wraps across lines.
        //
        // Imports are stripped first. `import { authenticate } from "../middleware/auth.middleware"`
        // contains the word the guard check looks for, so without this any route
        // declared within a dozen lines of the import block passed for free - the
        // gate reported every route in a file as guarded while `router.use` had
        // been deleted. The self-test caught it by deleting the guard.
        const window = lines
            .slice(i, i + 14)
            .filter((l) => !/^\s*import\b/.test(l))
            .join("\n");

        const routerLevel = routerGuards.filter((g) => g.line < i && AUTH.test(g.args));
        const inline = AUTH.test(window);
        const isPublic = !routerLevel.length && !inline;

        if (isPublic) {
            // An unguarded route is only acceptable if it is on the list, with a
            // reason, and - when it returns rows belonging to a person - with a
            // named field it must not select.
            const declared = PUBLIC_WITH_USER_DATA[base];
            const routeKey = m[2];
            const covered = declared?.find((d) => routeKey.includes(d.route.split("/").pop()));
            if (!covered) {
                problems += 1;
                console.log(`UNGUARDED  ${base} L${i + 1}  ${m[1].toUpperCase()} ${m[2]}`);
                console.log(`          not on the public list, and not declared under PUBLIC_WITH_USER_DATA`);
            } else {
                // The declared fields must be absent from the query that serves
                // this route, and only from that query.
                const serviceSrc = fs.readFileSync(path.join(ROOT, covered.service), "utf8");
                const body = methodBody(serviceSrc, covered.method);
                if (body === null) {
                    problems += 1;
                    console.log(`UNKNOWN    ${base} ${m[2]}`);
                    console.log(`          declared against ${covered.method}(), which was not found in ${covered.service}`);
                } else {
                    // The `\s*` before each brace matters and cost me an hour:
                    // written as `select\s*:\{` it does not match `select: {`,
                    // so the check silently matched nothing and reported every
                    // public route as clean.
                    const leaks = covered.mustNotSelect.filter((field) =>
                        new RegExp(
                            `(user|patient|author)\\s*:\\s*\\{\\s*select\\s*:\\s*\\{[^}]*${field.replace(
                                " ",
                                "\\s*"
                            )}`,
                            "s"
                        ).test(body)
                    );
                    if (leaks.length) {
                        problems += 1;
                        console.log(`LEAK       ${base} L${i + 1}  ${m[1].toUpperCase()} ${m[2]}`);
                        console.log(`          ${covered.method}() selects ${leaks.join(", ")} - ${covered.why}`);
                    } else {
                        console.log(
                            `  ok  ${base.padEnd(24)} ${m[1].toUpperCase().padEnd(6)} ${m[2].padEnd(28)} public, no user identity (${covered.why})`
                        );
                    }
                }
            }
        } else {
            // Report *which* guard, because "authenticated" and "admin" are not
            // the same claim and a reviewer should not have to go and check.
            const how = routerLevel.length
                ? `router.use(${routerLevel[routerLevel.length - 1].args.trim()})`
                : "inline middleware";
            console.log(`  ok  ${base.padEnd(24)} ${m[1].toUpperCase().padEnd(6)} ${m[2].padEnd(28)} via ${how}`);
        }
    });
}

console.log(
    `\n${checked} routes checked, ${problems} unguarded or leaking, across ${
        walk(path.join(ROOT, "server", "src", "routes")).length
    } files`
);

// The exit code is the gate. This line was missing from the first version, which
// printed the problem count to stdout and then exited 0 - so in CI it looked like
// a passing step while reporting failures, and would never have stopped a merge.
// A checker that cannot fail is a comment.
//
// The self-test asserts this by deleting a guard and requiring a non-zero exit.
process.exit(problems === 0 ? 0 : 1);
