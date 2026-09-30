import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the migration away from substring-derived HTTP status codes.
 *
 * The API used to decide an error's status by matching the thrown *message*
 * (`message.includes("Forbidden") ? 403 : 400`). That coupled the HTTP contract
 * to English prose, and produced two classes of bug: a reworded message silently
 * changed the status code, and a driver/ORM message containing "not found"
 * turned an internal fault into a 404. Every service now throws a typed
 * `AppError` and every controller reads `publicMessageFor(error)?.status`.
 *
 * These assertions fail if the pattern is reintroduced anywhere.
 */
const SRC = join(__dirname, "..", "src");

const readAll = (dir: string): { file: string; text: string }[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return readAll(full);
        if (!entry.name.endsWith(".ts")) return [];
        return [{ file: full.slice(SRC.length + 1), text: readFileSync(full, "utf8") }];
    });

const sources = readAll(SRC);

/**
 * Strips comments so a comment *describing* the anti-pattern (as several of
 * these controllers do, to explain what was fixed) is not itself flagged.
 */
const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("typed error status (no substring-derived HTTP status)", () => {
    it("has sources to scan", () => {
        expect(sources.length).toBeGreaterThan(20);
    });

    it("no controller derives a status from an error message", () => {
        // Covers every form this has taken: `.includes("Forbidden")`,
        // `.startsWith("Forbidden")`, a regex `.test(message)`, and a
        // hand-rolled `clientErrors.some((f) => message.includes(f))` allowlist.
        const offenders = sources
            .filter(({ file }) => file.startsWith("controllers"))
            .filter(({ text }) => {
                const code = stripComments(text);
                return (
                    /message\s*\)?\s*\.\s*(includes|startsWith|indexOf|endsWith)\s*\(/.test(code) ||
                    /\.test\(\s*message\s*\)/.test(code) ||
                    /message\.(includes|startsWith)\(/.test(code)
                );
            })
            .map(({ file }) => file);
        expect(offenders).toEqual([]);
    });

    it("no service throws a bare `new Error` with a status-bearing message", () => {
        // Plain `Error` is still legitimate for genuinely internal failures
        // (SMTP misconfiguration, driver faults), so only business messages
        // that would have carried a status are rejected here.
        const offenders = sources
            .filter(({ file }) => file.startsWith("services"))
            .filter(({ text }) =>
                /throw new Error\(\s*"(?:[^"\\]|\\.)*(?:not found|Forbidden|already|unauthorized)/i.test(
                    stripComments(text)
                )
            )
            .map(({ file }) => file);
        expect(offenders).toEqual([]);
    });

    it("typed AppError factories round-trip their status through publicMessageFor", async () => {
        const { badRequest, unauthorized, forbidden, notFound, conflict, publicMessageFor } = await import(
            "../src/utils/appError"
        );

        expect(publicMessageFor(badRequest("m"))?.status).toBe(400);
        expect(publicMessageFor(unauthorized())?.status).toBe(401);
        expect(publicMessageFor(forbidden("not your appointment"))?.status).toBe(403);
        expect(publicMessageFor(notFound("Doctor profile not found"))?.status).toBe(404);
        expect(publicMessageFor(conflict("already exists"))?.status).toBe(409);
    });

    it("a typed error is not reclassified by its wording", async () => {
        const { badRequest, publicMessageFor } = await import("../src/utils/appError");

        // The exact failure the old code produced: a 400 whose text happened to
        // contain "not found" was promoted to a 404 by the substring match.
        const err = badRequest("Upstream said: patient record not found");
        expect(publicMessageFor(err)?.status).toBe(400);
    });
});
