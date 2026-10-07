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

/**
 * The Go service's own event-type list, and the client's fan-out map.
 *
 * The assertions above are TypeScript-to-TypeScript for the two that matter most:
 * the Go service forwards `type` as an opaque string, so it cannot break on a
 * rename, and nothing was comparing the two lists that *do* exist downstream.
 *
 * That is how `hub.go`'s `criticalTypes` came to contain five event types nothing
 * publishes - `risk:new`, `risk:updated`, `crisis`, `appointment:new`,
 * `appointment:update` - while omitting `sos:alert` and `risk:alert`, the two
 * events the service exists to deliver. The counters built to surface lost
 * clinical alerts therefore reported every real drop as cosmetic.
 *
 * `drops_test.go` asserted the wrong list matched itself, which is why it passed.
 * These assertions compare the Go list and the client map to the TypeScript union
 * instead, so a new event type has to be classified in all three places.
 */
describe("event type classification across the three languages", () => {
    const ROOT = join(__dirname, "..", "..");

    /** Removes `//` line comments so prose is not read as configuration. */
    const stripGoComments = (text: string): string =>
        text.replace(/\/\/[^\n]*/g, "");

    const declaredTypes = (): string[] => {
        const source = readFileSync(join(SRC, "services", "realtime.service.ts"), "utf8");
        const union = source.match(/export type RealtimeEventType =([\s\S]*?);/);
        expect(union).not.toBeNull();
        return [...union![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    };

    /** Every string literal inside the Go `criticalTypes` map. */
    const goCriticalTypes = (): string[] => {
        const go = readFileSync(join(ROOT, "server-realtime", "hub", "hub.go"), "utf8");
        const map = go.match(/var criticalTypes = map\[string\]bool\{([\s\S]*?)\n\}/);
        expect(map, "criticalTypes map not found in hub.go").not.toBeNull();
        // Strip comments before reading the literals. Every entry in this map has
        // a comment above it explaining why it is classified the way it is, and
        // one of those comments contains a quoted phrase - so the first version
        // of this extractor reported the prose as an event type. Same reason
        // `error-status.test.ts` strips comments before grepping: a comment
        // describing a pattern must not be read as an instance of it.
        const body = stripGoComments(map![1]);
        return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    };

    /** The keys of the client's FANOUT map. */
    const clientFanout = (): string[] => {
        const hook = readFileSync(join(ROOT, "client", "hooks", "useRealtime.ts"), "utf8");
        const map = hook.match(/const FANOUT[^=]*=\s*\{([\s\S]*?)\n\};/);
        expect(map, "FANOUT map not found in useRealtime.ts").not.toBeNull();
        // Keys are bare identifiers, quoted or not depending on the style used.
        return [...map![1].matchAll(/^\s*(?:"|')?([a-zA-Z]+:[a-zA-Z]+)(?:"|')?\s*:/gm)].map(
            (m) => m[1]
        );
    };

    it("classifies only event types that exist", () => {
        const declared = new Set(declaredTypes());
        const phantom = goCriticalTypes().filter((t) => !declared.has(t));
        expect(
            phantom,
            `hub.go classifies types nothing publishes: ${phantom.join(", ")}`
        ).toEqual([]);
    });

    it("classifies every clinical alert as critical", () => {
        // The whole point of the counters. A dropped SOS press or risk disclosure
        // is the failure this service exists to make visible.
        const critical = new Set(goCriticalTypes());
        expect(critical.has("sos:alert"), "a dropped SOS must count as critical").toBe(true);
        expect(critical.has("risk:alert"), "a dropped risk alert must count as critical").toBe(true);
    });

    it("does not classify the purely presentational events as critical", () => {
        // Read receipts and typing indicators are safe to lose: the next poll or
        // the next keystroke renders the same truth. Counting them would dilute
        // the counter that clinicians are actually paged by.
        const critical = new Set(goCriticalTypes());
        for (const cosmetic of ["typing:start", "typing:stop", "message:read"]) {
            expect(critical.has(cosmetic), `${cosmetic} should be cosmetic`).toBe(false);
        }
    });

    it("has a client fan-out entry for every published type", () => {
        const declared = new Set(declaredTypes());
        const fanout = new Set(clientFanout());
        // `notification:new` is handled by its own subscription rather than the
        // generic fan-out map, so it is expected to be absent here.
        const missing = [...declared].filter(
            (t) => !fanout.has(t) && t !== "notification:new"
        );
        expect(
            missing,
            `the client would silently discard: ${missing.join(", ")}`
        ).toEqual([]);
    });

    it("has no fan-out entry for a type the API does not publish", () => {
        const declared = new Set(declaredTypes());
        const orphans = clientFanout().filter((t) => !declared.has(t));
        expect(orphans, `client handles unpublished types: ${orphans.join(", ")}`).toEqual([]);
    });
});
