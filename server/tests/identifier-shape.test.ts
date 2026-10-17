import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * The identifier rule, checked against the schema and the route schemas.
 *
 * This is a meta-test in the same spirit as `rate-limit-store.test.ts`: the
 * requirement is not that today's models are right, it is that a new model
 * cannot arrive with a sequential integer key and no one notices. Types make
 * that visible inside the API, but the schema is the one file where the public
 * surface is declared, so it is the file worth reading back.
 *
 * What "right" means here:
 *
 *   - every model's primary key is UUIDv7 (`String @id @default(uuid(7))`),
 *     except a model whose natural key is already opaque (`JobLock`'s `key`);
 *   - no `\w+Id` scalar is an `Int`, because a foreign-key value in a response
 *     would otherwise leak the internal identity the UUIDs exist to hide;
 *   - no route schema coerces an id to a number - a numeric id is rejected at
 *     the boundary, not silently translated.
 */
const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");

const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\s*\}/gm)].map(
    ([, name, body]) => ({ name, body })
);

describe("external identifiers", () => {
    it("gives every model a UUIDv7 primary key, or a natural string key", () => {
        expect(models.length).toBeGreaterThanOrEqual(28);

        const autoIncrement = models
            .filter(({ body }) => /@default\(autoincrement\(\)\)/.test(body) || /^\s*id\s+Int\b/m.test(body))
            .map((m) => m.name);
        expect(autoIncrement).toEqual([]);

        const uuidPk = models.filter(({ body }) =>
            /^\s*id\s+String\s+@id\s+@default\(uuid\(7\)\)/m.test(body)
        );
        // `JobLock` is the one model keyed by a natural opaque string (`key`).
        expect(uuidPk).toHaveLength(models.length - 1);
    });

    it("makes every id-typed column a string", () => {
        const offenders = models.flatMap(({ name, body }) =>
            [...body.matchAll(/^\s*(\w+Id)\s+Int\b/gm)].map((m) => `${name}.${m[1]}`)
        );
        expect(offenders).toEqual([]);
    });

    it("validates route ids as UUIDv7 before handlers run", () => {
        const params = fs.readFileSync(
            path.resolve(__dirname, "../src/schemas/params.schema.ts"),
            "utf8"
        );
        expect(params).toMatch(/export const uuid7 = z\.string\(\)\.regex\(/);
        // Version 7 specifically, not "any uuid": the format is the requirement.
        expect(params).toMatch(/-7\[0-9a-f\]\{3\}/);
        expect(params).not.toMatch(/z\.coerce\.number\(\)/);

        // No schema anywhere coerces an id-shaped field to a number.
        const schemasDir = path.resolve(__dirname, "../src/schemas");
        const coercions = fs
            .readdirSync(schemasDir)
            .filter((f) => f.endsWith(".ts"))
            .flatMap((file) => {
                const text = fs.readFileSync(path.join(schemasDir, file), "utf8");
                return [...text.matchAll(/(\w+Id):\s*z\.(?:coerce\.)?number\(\)/g)].map(
                    (m) => `${file}:${m[1]}`
                );
            });
        expect(coercions).toEqual([]);
    });
});
