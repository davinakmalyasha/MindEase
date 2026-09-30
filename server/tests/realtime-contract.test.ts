import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Contract between the API, the Go realtime service and the web client.
 *
 * The API publishes `{ userId, type, payload }` to Redis; the Go service parses
 * that envelope and pushes `{ type, payload }` down the socket. The client
 * dispatches by `type`. Nothing previously pinned any of it, so a renamed event
 * type compiled cleanly and simply stopped arriving.
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

describe("realtime event contract", () => {
    it("publishes only event types declared in RealtimeEventType", async () => {
        // The union is the source of truth; read it back rather than duplicating
        // the list, so adding a type here is a one-line change.
        const source = readFileSync(join(SRC, "services", "realtime.service.ts"), "utf8");
        const union = source.match(/export type RealtimeEventType =([\s\S]*?);/);
        expect(union).not.toBeNull();
        const declared = new Set(
            [...(union![1].matchAll(/"([^"]+)"/g))].map((m) => m[1])
        );
        expect(declared.size).toBeGreaterThan(0);

        // Every literal passed to publishEvent must be declared. Collected from
        // the whole call expression so a conditional (`isTyping ? ... : ...`)
        // contributes both branches.
        const published = new Set<string>();
        for (const { text } of sources) {
            for (const call of text.matchAll(/publishEvent\([\s\S]*?\n\s*\}\);/g)) {
                for (const literal of call[0].matchAll(/type:\s*(?:"([^"]+)"|\w+\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)")/g)) {
                    for (const g of literal.slice(1)) if (g) published.add(g);
                }
            }
        }

        expect(published.size).toBeGreaterThan(0);
        const undeclared = [...published].filter((t) => !declared.has(t));
        expect(undeclared).toEqual([]);
    });

    it("declares no type that nothing publishes", async () => {
        // Catches a type left behind after its publisher was deleted.
        const source = readFileSync(join(SRC, "services", "realtime.service.ts"), "utf8");
        const union = source.match(/export type RealtimeEventType =([\s\S]*?);/)!;
        const declared = [...union[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

        const published = new Set<string>();
        for (const { text } of sources) {
            for (const call of text.matchAll(/publishEvent\([\s\S]*?\n\s*\}\);/g)) {
                for (const literal of call[0].matchAll(/type:\s*(?:"([^"]+)"|\w+\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)")/g)) {
                    for (const g of literal.slice(1)) if (g) published.add(g);
                }
            }
        }

        const orphans = declared.filter((t) => !published.has(t));
        expect(orphans).toEqual([]);
    });

    it("publishes the Redis envelope the Go service parses", () => {
        // The Go `redisEvent` struct reads exactly these three fields.
        const source = readFileSync(join(SRC, "services", "realtime.service.ts"), "utf8");
        expect(source).toMatch(/JSON\.stringify\(\{\s*userId/);
        expect(source).toMatch(/type:\s*event\.type/);
        expect(source).toMatch(/payload:\s*event\.payload\s*\?\?\s*null/);
    });

    it("the Go service and the client agree on the envelope field names", () => {
        const go = readFileSync(
            join(__dirname, "..", "..", "server-realtime", "main.go"),
            "utf8"
        );
        expect(go).toMatch(/UserID\s+int64\s+`json:"userId"`/);
        expect(go).toMatch(/Type\s+string\s+`json:"type"`/);
        expect(go).toMatch(/Payload\s+json\.RawMessage\s+`json:"payload"`/);

        const clientHook = readFileSync(
            join(__dirname, "..", "..", "client", "hooks", "useRealtime.ts"),
            "utf8"
        );
        // The client reads the same two fields off the socket frame.
        expect(clientHook).toMatch(/\.type/);
        expect(clientHook).toMatch(/\.payload/);
    });
});
