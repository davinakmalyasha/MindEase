#!/usr/bin/env node
/**
 * Cross-platform task runner for the repository.
 *
 * ## Why this exists instead of a Makefile
 *
 * The repo used to be driven by `make`. That is a Unix build tool: most
 * Windows developers do not have it, and one of the reviewers of this project
 * cloned it, typed the quick-start, and got `make: command not found`. A
 * convenience remote must not be the thing that decides whether the demo runs.
 *
 * Node is already a hard requirement (the web client is Next.js), so `npm
 * run <task>` needs nothing installed that the project does not already need.
 * Every command below is also printed verbatim, so a reader who does not want
 * `npm` can copy it out of the terminal.
 *
 * ## Commands
 *
 *   node scripts/task.js <task> [args...]
 *
 * Run `node scripts/task.js help` (or `npm run help`) for the list.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CLIENT = path.join(ROOT, "client");
const API = path.join(ROOT, "server-go");
const REALTIME = path.join(ROOT, "server-realtime");

const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const npxCmd = isWin ? "npx.cmd" : "npx";

// ---------------------------------------------------------------- helpers ----

/** Read the root `.env` into a plain object. Never printed. */
function readRootEnv() {
    const file = path.join(ROOT, ".env");
    if (!fs.existsSync(file)) return {};
    const out = {};
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        out[m[1]] = v;
    }
    return out;
}

/**
 * Spawn primitive. On Windows an `.cmd` shim (npm) must go through cmd.exe;
 * `shell: true` would concatenate arguments unescaped (Node DEP0190), so the
 * shim is invoked explicitly instead.
 */
function spawnCommand(cmd, args, opts = {}) {
    const base = {
        cwd: opts.cwd || ROOT,
        stdio: opts.stdio || "inherit",
        env: { ...process.env, ...opts.env },
    };
    if (isWin && /\.cmd$/i.test(cmd)) {
        return spawn("cmd.exe", ["/c", cmd, ...args], base);
    }
    return spawn(cmd, args, base);
}

/** Same, but synchronous and capturing output (for version probes). */
function probe(cmd, args) {
    const base = { encoding: "utf8" };
    if (isWin && /\.cmd$/i.test(cmd)) {
        return spawnSync("cmd.exe", ["/c", cmd, ...args], base);
    }
    return spawnSync(cmd, args, base);
}

/** Run one command, inheriting stdio. Throws on a non-zero exit. */
function run(cmd, args, opts = {}) {
    const printable = [cmd, ...args].join(" ");
    console.log(`\n$ ${printable}${opts.cwd ? `   (in ${path.relative(ROOT, opts.cwd) || "."})` : ""}`);
    const res = spawnSync(
        isWin && /\.cmd$/i.test(cmd) ? "cmd.exe" : cmd,
        isWin && /\.cmd$/i.test(cmd) ? ["/c", cmd, ...args] : args,
        {
            cwd: opts.cwd || ROOT,
            stdio: "inherit",
            env: { ...process.env, ...opts.env },
        }
    );
    if (res.status !== 0) {
        const err = new Error(`command failed (${res.status}): ${printable}`);
        err.exitCode = res.status || 1;
        throw err;
    }
}

/** Run several commands in order. */
function runAll(steps) {
    for (const step of steps) run(step.cmd, step.args, step.opts);
}

/**
 * The database URL the Go services use for local development.
 *
 * Defaults to the root account with no password, because that is what a stock
 * Laragon/XAMPP/WSL MySQL gives you. Override with DATABASE_URL, exactly as the
 * API itself does.
 */
function devDatabaseURL() {
    const env = readRootEnv();
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    if (env.DATABASE_URL) return env.DATABASE_URL;
    const user = process.env.MYSQL_USER || "root";
    const pass = process.env.MYSQL_PASSWORD || "";
    const host = process.env.MYSQL_HOST || "127.0.0.1:3306";
    const db = process.env.MYSQL_DATABASE || "mindease_db";
    return `mysql://${user}:${pass}@${host}/${db}`;
}

/** Run a `go` command in one of the two Go modules, with DATABASE_URL set. */
function goTask(module, args, env = {}) {
    run("go", args, { cwd: module, env: { DATABASE_URL: devDatabaseURL(), ...env } });
}

/**
 * Environment a service needs locally, loaded from .env like the old dev.sh did
 * — minus `PORT`. The root .env's PORT belongs to the API; leaking it into the
 * realtime hub or Next.js would make them fight the API for :5000. Each task
 * sets its own port below.
 */
function serviceEnv(extra = {}) {
    const env = { ...readRootEnv(), ...process.env, ...extra };
    if (!("PORT" in extra)) delete env.PORT;
    return env;
}

// ------------------------------------------------------------------ tasks ----

const tasks = {
    help: {
        description: "List every task",
        run() {
            console.log("MindEase tasks\n");
            const width = Math.max(...Object.keys(tasks).map((k) => k.length));
            for (const [name, task] of Object.entries(tasks)) {
                console.log(`  ${name.padEnd(width)}  ${task.description}`);
            }
            console.log("\nEvery task prints the command it runs; nothing is hidden.");
        },
    },

    doctor: {
        description: "Report whether this machine has what the tasks need",
        run() {
            const checks = [
                ["node", "node", ["--version"], "24 LTS (see .nvmrc)"],
                ["npm", npmCmd, ["--version"], "ships with Node"],
                ["go", "go", ["version"], "1.27 (server-go/go.mod)"],
                ["mysql client", "mysql", ["--version"], "optional; the API needs a reachable server"],
                ["docker", "docker", ["--version"], "only for `npm run up` and `npm run down`"],
            ];
            console.log("MindEase environment\n");
            for (const [label, cmd, args, note] of checks) {
                const res = probe(cmd, args);
                const ok = res.status === 0;
                const version = ok ? (res.stdout || res.stderr).trim().split("\n")[0] : "";
                console.log(`  ${label.padEnd(14)} ${ok ? version : `MISSING (${note})`}`);
            }
            const env = readRootEnv();
            console.log(`\n  .env           ${fs.existsSync(path.join(ROOT, ".env")) ? "present" : "missing - run `npm run setup`"}`);
            console.log(`  client env     ${fs.existsSync(path.join(CLIENT, ".env.local")) ? "present" : "missing - run `npm run setup`"}`);
            console.log(`  database       ${devDatabaseURL().replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@")}`);
            console.log(`  jwt secret     ${env.JWT_SECRET ? "set in .env" : "unset - run `npm run env`"}`);
            console.log("\n  Checking MySQL and Redis reachability...");
            probePort("mysql", 3306);
            probePort("redis", 6379);
        },
    },

    setup: {
        description: "Install dependencies and create the env files",
        run() {
            run(npmCmd, ["ci"], { cwd: CLIENT });
            run("go", ["mod", "download"], { cwd: API });
            run("go", ["mod", "download"], { cwd: REALTIME });
            run("node", ["scripts/setup-env.js"]);
            run("node", ["scripts/task.js", "doctor"]);
        },
    },

    env: {
        description: "Create the root .env and client/.env.local if missing",
        run() {
            run("node", ["scripts/setup-env.js"]);
        },
    },

    "db:migrate": {
        description: "Apply the committed migrations to the local database",
        run() {
            goTask(API, ["run", "./cmd/migrate"]);
        },
    },

    "db:seed": {
        description: "Create the demo accounts and seeded data",
        run() {
            goTask(API, ["run", "./cmd/seed"]);
        },
    },

    "db:setup": {
        description: "Migrate and seed the local database",
        run() {
            tasks["db:migrate"].run();
            tasks["db:seed"].run();
        },
    },

    "dev:api": {
        description: "Run the API on :5000, loading the root .env",
        run() {
            run("go", ["run", "./cmd/api"], { cwd: API, env: serviceEnv({ PORT: "5000" }) });
        },
    },

    "dev:realtime": {
        description: "Run the realtime WebSocket service on :8080",
        run() {
            run("go", ["run", "."], { cwd: REALTIME, env: serviceEnv({ PORT: "8080" }) });
        },
    },

    "dev:web": {
        description: "Run the Next.js client on :3000 (override with WEB_PORT)",
        run() {
            const port = process.env.WEB_PORT || "3000";
            run(npmCmd, ["run", "dev", "--", "--port", port], { cwd: CLIENT, env: serviceEnv({ PORT: port }) });
        },
    },

    dev: {
        description: "Run all three services together (Ctrl-C stops them)",
        run() {
            const children = [
                ["api", "go", ["run", "./cmd/api"], API, { PORT: "5000" }],
                ["realtime", "go", ["run", "."], REALTIME, { PORT: "8080" }],
                ["web", npmCmd, ["run", "dev", "--", "--port", process.env.WEB_PORT || "3000"], CLIENT, { PORT: process.env.WEB_PORT || "3000" }],
            ].map(([name, cmd, args, cwd, env]) => {
                const child = spawnCommand(cmd, args, { cwd, env: serviceEnv(env) });
                child.on("exit", (code) => {
                    if (code && code !== 0) console.error(`[${name}] exited with ${code}`);
                });
                return child;
            });
            console.log("\n  api        http://localhost:5000/api/health");
            console.log("  realtime   http://localhost:8080/health");
            console.log("  web        http://localhost:3000\n");
            const stop = () => {
                for (const c of children) {
                    try {
                        c.kill();
                    } catch {
                        /* already gone */
                    }
                }
                process.exit(0);
            };
            process.on("SIGINT", stop);
            process.on("SIGTERM", stop);
        },
    },

    lint: {
        description: "Lint the client, then both Go modules",
        run() {
            run(npmCmd, ["run", "lint"], { cwd: CLIENT });
            goTask(API, ["vet", "./..."]);
            goTask(REALTIME, ["vet", "./..."]);
        },
    },

    typecheck: {
        description: "Typecheck the client",
        run() {
            run(npxCmd, ["tsc", "--noEmit"], { cwd: CLIENT });
        },
    },

    build: {
        description: "Production-build the client",
        run() {
            run(npmCmd, ["run", "build"], { cwd: CLIENT });
        },
    },

    test: {
        description: "Client unit tests plus both Go modules",
        run() {
            run(npmCmd, ["test"], { cwd: CLIENT });
            run("go", ["test", "./..."], { cwd: API });
            run("go", ["test", "-race", "-cover", "./..."], { cwd: REALTIME });
        },
    },

    "test:client": {
        description: "Client unit tests",
        run() {
            run(npmCmd, ["test"], { cwd: CLIENT });
        },
    },

    "test:go": {
        description: "Go tests (API integration runs when TEST_DATABASE_URL is set)",
        run() {
            run("go", ["test", "./..."], { cwd: API });
            run("go", ["test", "-race", "-cover", "./..."], { cwd: REALTIME });
        },
    },

    coverage: {
        description: "Go statement coverage for both modules",
        run() {
            run("go", ["test", "-covermode=atomic", "-coverprofile=coverage.out", "./..."], {
                cwd: API,
                env: { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || devDatabaseURL() },
            });
            run("go", ["tool", "cover", "-func=coverage.out"], { cwd: API });
            run("go", ["test", "-race", "-covermode=atomic", "-coverprofile=coverage.out", "./..."], { cwd: REALTIME });
            run("go", ["tool", "cover", "-func=coverage.out"], { cwd: REALTIME });
        },
    },

    check: {
        description: "Every static gate (no database or browser needed)",
        run() {
            const gates = [
                "typecheck", "lint",
                "check:encoding", "check:workflows", "check:a11y-ids", "check:csp",
                "check:i18n", "check:a11y", "check:load-states", "check:stale-writes",
                "check:ui-hygiene", "check:dependencies", "check:numbers",
            ];
            for (const g of gates) tasks[g].run();
        },
    },

    "check:encoding": {
        description: "Repo-wide mojibake guard",
        run() {
            run("node", ["scripts/check-encoding.test.js"]);
            run("node", ["scripts/check-encoding.js"]);
        },
    },

    "check:numbers": {
        description: "Documented counts must match the tree",
        run() {
            run("node", ["scripts/check-numbers.test.js"]);
            run("node", ["scripts/check-numbers.js"]);
        },
    },

    "check:workflows": {
        description: "Workflow jobs declare permissions/timeouts; actions are pinned",
        run() {
            run("node", ["scripts/check-workflows.test.js"]);
            run("node", ["scripts/check-workflows.js"]);
        },
    },

    "check:a11y-ids": {
        description: "No duplicate or orphaned ids, no two labels sharing one id",
        run() {
            run("node", ["scripts/check-a11y-ids.test.js"]);
            run("node", ["scripts/check-a11y-ids.js"]);
        },
    },

    "check:csp": {
        description: "CSP is well-formed and permits the configured API",
        run() {
            run("node", ["scripts/check-csp.test.js"]);
            run("node", ["scripts/check-csp.js"]);
        },
    },

    "check:i18n": {
        description: "Every t() key resolves in every locale",
        run() {
            run("node", ["scripts/check-i18n.test.js"]);
            run("node", ["scripts/check-i18n.js"]);
        },
    },

    "check:a11y": {
        description: "Buttons have names, errors are announced, contrast budget holds",
        run() {
            run("node", ["scripts/check-a11y.test.js"]);
            run("node", ["scripts/check-a11y.js"]);
        },
    },

    "check:load-states": {
        description: "A failed request never renders as an empty result",
        run() {
            run("node", ["scripts/check-load-states.test.js"]);
            run("node", ["scripts/check-load-states.js"]);
        },
    },

    "check:stale-writes": {
        description: "No stale response overwrites a newer one; cursors only advance on success",
        run() {
            run("node", ["scripts/check-stale-writes.test.js"]);
            run("node", ["scripts/check-stale-writes.js"]);
        },
    },

    "check:ui-hygiene": {
        description: "Hardcoded strings and locale bypasses may fall, never rise",
        run() {
            run("node", ["scripts/check-ui-hygiene.test.js"], { cwd: CLIENT });
            run("node", ["scripts/check-ui-hygiene.js"], { cwd: CLIENT });
        },
    },

    "check:dependencies": {
        description: "Every declared npm package is referenced",
        run() {
            run("node", ["scripts/check-dependencies.test.js"], { cwd: CLIENT });
            run("node", ["scripts/check-dependencies.js"], { cwd: CLIENT });
        },
    },

    e2e: {
        description: "Playwright journeys against the running stack",
        run() {
            run(npxCmd, ["playwright", "test"], { cwd: CLIENT });
        },
    },

    numbers: {
        description: "Print the counts the documentation quotes",
        run() {
            run("node", ["scripts/check-numbers.js"]);
        },
    },

    verify: {
        description: "Pre-push gate: static checks, build, tests (unit-only)",
        run() {
            tasks.check.run();
            tasks.build.run();
            tasks.test.run();
            console.log("\nNot run here: `npm run e2e` needs a running stack; `npm run up` needs Docker.");
        },
    },

    up: {
        description: "Build and boot the compose stack, then seed it (needs Docker)",
        run() {
            if (!hasDocker()) {
                console.error(
                    "Docker was not found. This repository can also run natively:\n" +
                        "  npm run doctor      # check MySQL/Redis/Go/Node\n" +
                        "  npm run db:setup    # migrate + seed\n" +
                        "  npm run dev         # api + realtime + web\n"
                );
                process.exit(1);
            }
            run("docker", ["compose", "build"], {
                env: { ALLOW_PAYMENT_SIMULATOR: "true" },
            });
            run("docker", ["compose", "up", "-d", "--wait"], {
                env: { ALLOW_PAYMENT_SIMULATOR: "true" },
            });
            tasks["db:seed"].run();
            console.log("\n  web        http://localhost:3000");
            console.log("  api        http://localhost:5000/api/health");
            console.log("  realtime   http://localhost:8080/health");
        },
    },

    down: {
        description: "Stop the compose stack (needs Docker)",
        run() {
            run("docker", ["compose", "down"]);
        },
    },

    logs: {
        description: "Follow the compose logs (needs Docker)",
        run() {
            run("docker", ["compose", "logs", "-f"]);
        },
    },
};

function hasDocker() {
    return probe("docker", ["--version"]).status === 0;
}

/** Report whether a TCP port answers, without throwing. */
function probePort(name, port) {
    const net = require("net");
    const socket = new net.Socket();
    const timer = setTimeout(() => socket.destroy(), 1500);
    socket.once("connect", () => {
        clearTimeout(timer);
        console.log(`    ${name.padEnd(8)} :${port} reachable`);
        socket.destroy();
    });
    socket.once("error", () => {
        clearTimeout(timer);
        console.log(`    ${name.padEnd(8)} :${port} NOT reachable (start it before \`npm run db:setup\`)`);
    });
    socket.connect(port, "127.0.0.1");
}

// ------------------------------------------------------------------ main -----

const [taskName, ...rest] = process.argv.slice(2);

if (!taskName || taskName === "help" || taskName === "--help" || taskName === "-h") {
    tasks.help.run();
    process.exit(0);
}

const task = tasks[taskName];
if (!task) {
    console.error(`Unknown task: ${taskName}\n`);
    tasks.help.run();
    process.exit(1);
}

if (rest.length) {
    console.error(`Task "${taskName}" takes no arguments; got: ${rest.join(" ")}`);
    process.exit(1);
}

try {
    task.run();
} catch (e) {
    console.error(`\n${e.message}`);
    process.exit(e.exitCode || 1);
}
