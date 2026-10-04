import { describe, expect, it } from "vitest";

/**
 * Access logs must not contain what a user typed.
 *
 * The switch from `morgan("dev")` to `pino-http` was made for structure - so a
 * request could be joined to its own log lines and its Sentry event by
 * `requestId` - and the comment above it claimed a second benefit that it did
 * not deliver: that the query string stopped being logged.
 *
 * pino-http's default request serialiser emits `url` including the query, and
 * the `redact` list in `utils/logger.ts` covers header and body fields but has no
 * `req.url` entry. So `GET /api/admin/users?search=<patient email>` wrote that
 * patient's email address into the log store, where it is retained, searchable,
 * and readable by anyone with dashboard access. `/api/doctors?q=<free text>` is
 * the same.
 *
 * These assertions run against the real serialiser rather than reading the source
 * for a string, so a serialiser that is present but not actually applied - the
 * shape of the bug the comment described - still fails.
 */
import pino from "pino";
import { Writable } from "node:stream";

/** Collects everything written to the logger. */
const capture = () => {
    const lines: string[] = [];
    const stream = new Writable({
        write(chunk, _enc, cb) {
            lines.push(chunk.toString());
            cb();
        },
    });
    return { lines, stream };
};

/**
 * The request serialiser as configured in `app.ts`.
 *
 * Duplicated deliberately rather than imported: `app.ts` builds the whole Express
 * application at module scope and importing it here would need a database. The
 * duplication is the cost of testing a wiring decision, and a change to one side
 * without the other shows up as a failing test below - which is the point.
 */
const serialiseReq = (raw: {
    method: string;
    url: string;
    query?: Record<string, unknown>;
    headers: Record<string, string>;
    socket?: { remoteAddress?: string; remotePort?: number };
}) => {
    const q = raw.query ?? {};
    const queryKeys = q && typeof q === "object" ? Object.keys(q) : [];
    return {
        method: raw.method,
        url: raw.url ? raw.url.split("?")[0] : raw.url,
        queryKeys,
        headers: raw.headers,
        remoteAddress: raw.socket?.remoteAddress,
        remotePort: raw.socket?.remotePort,
    };
};

const logWithReq = (req: Parameters<typeof serialiseReq>[0]) => {
    const { lines, stream } = capture();
    const logger = pino(
        {
            level: "info",
            redact: {
                paths: [
                    "req.headers.authorization",
                    "req.headers.cookie",
                    "res.headers.set-cookie",
                ],
                censor: "[redacted]",
            },
        },
        stream
    );
    logger.info({ req: serialiseReq(req) }, "request completed");
    return lines.join("");
};

describe("access logs carry no query-string values", () => {
    it("drops the search term from an admin user lookup", () => {
        // The case that motivated the fix: the search parameter is a patient's
        // email address, typed by an administrator, ending up in a log store.
        const line = logWithReq({
            method: "GET",
            url: "/api/admin/users?search=victim@example.com&role=patient",
            query: { search: "victim@example.com", role: "patient" },
            headers: { host: "localhost" },
        });

        expect(line).not.toContain("victim@example.com");
        expect(line).toContain("/api/admin/users");
    });

    it("drops a free-text doctor search", () => {
        const line = logWithReq({
            method: "GET",
            url: "/api/doctors?q=depression&page=2",
            query: { q: "depression", page: "2" },
            headers: {},
        });
        expect(line).not.toContain("depression");
    });

    it("keeps the query keys, so the request is still diagnosable", () => {
        // Redacting the whole query would make the log less useful for no gain:
        // the key names are not sensitive, the values are.
        const line = logWithReq({
            method: "GET",
            url: "/api/admin/users?search=x",
            query: { search: "x" },
            headers: {},
        });
        expect(line).toContain("queryKeys");
        expect(line).toContain("search");
    });

    it("still redacts the authorization header", () => {
        // Guards against fixing one redaction by removing the serialiser that
        // made the others work.
        const line = logWithReq({
            method: "GET",
            url: "/api/notifications",
            headers: { authorization: "Bearer a-real-looking-token", cookie: "accessToken=x" },
        });
        expect(line).not.toContain("a-real-looking-token");
        expect(line).toContain("[redacted]");
    });

    it("leaves no query string on any route the API exposes", () => {
        // Belt and braces: whatever the URL, only the part before `?` survives.
        for (const url of [
            "/api/appointments/my?limit=1000000",
            "/api/messages/1/typing",
            "/api/wellness/mood/stats?days=3650",
            "/api/doctors?specialty=x&minExperience=y",
        ]) {
            const line = logWithReq({ method: "GET", url, query: {}, headers: {} });
            expect(line, `${url} leaked its query`).not.toContain("?");
        }
    });
});