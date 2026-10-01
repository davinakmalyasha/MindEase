import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Every rate limiter in this codebase must use the shared Redis-backed store.
 *
 * ## Why this test exists
 *
 * `express-rate-limit` silently defaults to an in-process `MemoryStore`. That is
 * correct for a single process and wrong for everything else: on two replicas
 * every ceiling is doubled, and a rolling deploy hands every attacker a free
 * reset of all counters.
 *
 * When the Redis store was introduced, five of seven limiters were converted and
 * two were missed - `generalLimiter` in `app.ts` and `aiLimiter` here. Both
 * looked correct in review because a bare `rateLimit({...})` is a perfectly
 * ordinary-looking line. Then two more were found in `routes/support.routes.ts`,
 * one of them the **SOS** limiter, where the bound is a safety ceiling rather
 * than a cost control: a person in escalating distress pressing the button again
 * was being counted twice over.
 *
 * `docs/security.md` listed all seven as Redis-backed the whole time, so the
 * documentation asserted something the code did not do.
 *
 * So this greps for the pattern rather than trusting review to catch it. The
 * one legitimate construction site is `sharedLimiter` itself.
 */
const SRC = path.resolve(__dirname, "../src");

const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
};

const relative = (p: string) => path.relative(SRC, p).replace(/\\/g, "/");

describe("rate limiter construction", () => {
    it("no source file builds a limiter with a bare rateLimit({...})", () => {
        const offenders: string[] = [];

        for (const file of walk(SRC)) {
            const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
            lines.forEach((line, i) => {
                // Skip comments - the prose in this file and in
                // `rateLimit.middleware.ts` mentions the pattern by name.
                if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
                if (line.trimStart().startsWith("/*")) return;
                // The one legitimate construction site: the body of
                // `sharedLimiter` itself, which is the line that injects the
                // store. Matched on the spread, not on the function name, because
                // the name is on a different line from the call.
                if (/rateLimit\(\{\s*\.\.\.base\(/.test(line)) return;
                if (/rateLimit\(\{/.test(line)) {
                    offenders.push(`${relative(file)}:${i + 1}  ${line.trim()}`);
                }
            });
        }

        // Assert the shape, not just the count, so a failure names the file.
        expect(offenders, `bare rateLimit({ found:\n${offenders.join("\n")}`).toEqual([]);
    });

    it("the shared helper does inject a store", () => {
        // The guard above is only as good as the thing it guards. If
        // `sharedLimiter` stopped supplying `store`, every limiter in the
        // codebase would quietly revert to per-process counting and the first
        // test would still pass.
        const source = fs.readFileSync(
            path.join(SRC, "middleware/rateLimit.middleware.ts"),
            "utf8"
        );
        const helper = source.slice(
            source.indexOf("export const sharedLimiter"),
            source.indexOf("export const sharedLimiter") + 400
        );
        expect(helper).toMatch(/\.\.\.base\(failClosed\)/);
    });

    it("every limiter exported from the middleware module is built by it", () => {
        // A named export like `export const someLimiter = rateLimit({` would
        // be caught by the first test, but an unexported local one would not be
        // visible as a symbol - so assert the count of constructors too.
        const source = fs.readFileSync(
            path.join(SRC, "middleware/rateLimit.middleware.ts"),
            "utf8"
        );
        const constructed = (source.match(/sharedLimiter\(\{/g) || []).length;
        // auth, reset, twoFactor, ai, account, and the one inside
        // `perUserWriteLimiter`. A new limiter must be added to this count, which
        // is the point: adding a limiter should be a deliberate act.
        expect(constructed).toBe(6);
    });
});
