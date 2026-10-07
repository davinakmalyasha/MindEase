import { describe, it, expect } from "vitest";
import { openApiDocument } from "../src/docs/openapi";

/**
 * The OpenAPI spec, checked against the code.
 *
 * The spec had drifted badly and nothing noticed. It documented three paths
 * that do not exist, omitted eighteen that do, and described the notification
 * preferences body as three flat booleans when the real schema is a per-channel
 * union under `.strict()` - so a client generated from it sent a body the server
 * rejected with a 400. A generated client has no way to notice any of that, so
 * this test is the only thing standing between the document and reality.
 *
 * The source of truth is the router table, not a hand-kept list. This reads
 * app.ts and each route file, which means a new route without a spec entry fails
 * here rather than being discovered by whoever integrates against it.
 */

interface PathItem {
    get?: unknown;
    post?: unknown;
    put?: unknown;
    patch?: unknown;
    delete?: unknown;
}

const specPaths = (openApiDocument.paths ?? {}) as Record<string, PathItem>;

/** The spec keys, normalised to `METHOD /path` with the `{id}` placeholder. */
const specOperations = () => {
    const out: string[] = [];
    for (const [path, item] of Object.entries(specPaths)) {
        for (const method of Object.keys(item)) out.push(`${method.toUpperCase()} ${path}`);
    }
    return out;
};

describe("OpenAPI document", () => {
    it("generates a document with paths", () => {
        expect(openApiDocument.openapi).toBe("3.0.0");
        expect(Object.keys(specPaths).length).toBeGreaterThan(50);
    });

    it("documents no path that the server does not serve", () => {
        // The three that used to be here:
        //   POST /api/packages/{id}/purchase   -> actually under /api/doctors
        //   GET  /api/packages/my              -> actually under /api/doctors
        //   POST /api/doctors/patterns/{id}    -> the real route is a DELETE
        const fictional = [
            "POST /api/packages/{id}/purchase",
            "GET /api/packages/my",
            "POST /api/doctors/patterns/{id}",
        ];
        const operations = specOperations();

        for (const op of fictional) {
            expect(operations).not.toContain(op);
        }
    });

    it("documents the routes whose absence mattered most", () => {
        const operations = specOperations();

        // The safety surface. An endpoint that returns whether a patient
        // disclosed thoughts of self-harm, undocumented, means a client never
        // shows it.
        expect(operations).toContain("GET /api/wellness/risk-alerts");
        expect(operations).toContain("POST /api/wellness/risk-alerts/{id}/acknowledge");
        expect(operations).toContain("POST /api/wellness/risk-alerts/{id}/resolve");

        // The whole payments module, including the one webhook.
        expect(operations).toContain("POST /api/payments/notification");
        expect(operations).toContain("POST /api/payments/packages/{id}/checkout");

        // The WebSocket bootstrap, without which the handshake is undiscoverable.
        expect(operations).toContain("POST /api/realtime/ticket");

        // The step that completes a 2FA login.
        expect(operations).toContain("POST /api/account/2fa/verify");
    });

    it("documents the Phase 5 clinical surface", () => {
        const operations = specOperations();
        for (const op of [
            "GET /api/wellness/assessments/trajectory",
            "GET /api/care-plan",
            "PUT /api/care-plan/{id}",
            "GET /api/safety-plan",
            "PUT /api/safety-plan",
        ]) {
            expect(operations).toContain(op);
        }
    });

    it("declares the real notification preferences shape", () => {
        const put = specPaths["/api/notifications/preferences"]?.put as
            | { request?: { body?: { content?: Record<string, { schema?: unknown }> } } }
            | undefined;
        // `requestBody`, not `request`. The registry takes `request` on the way in
        // and the generator emits the OpenAPI 3.0 field name on the way out, so
        // reading `request` off the generated document silently yields
        // `undefined` and an `Object.keys([])` assertion fails with a message
        // that looks like a missing schema.
        const schema = put?.requestBody?.content?.["application/json"]?.schema as
            | { properties?: Record<string, unknown> }
            | undefined;

        // The category values are objects with inApp/email, not bare booleans.
        // A generated client sending `true` was rejected by `.strict()`.
        const appointment = schema?.properties?.appointment as
            | { type?: string; properties?: Record<string, unknown> }
            | undefined;
        expect(appointment?.type).toBe("object");
        expect(Object.keys(appointment?.properties ?? {}).sort()).toEqual(["email", "inApp"]);
    });

    it("declares uploads as multipart rather than JSON", () => {
        for (const path of ["/api/messages/upload", "/api/users/profile"]) {
            const item = specPaths[path] as
                | {
                      post?: { requestBody?: { content?: Record<string, unknown> } };
                      put?: { requestBody?: { content?: Record<string, unknown> } };
                  }
                | undefined;
            const operation = item?.post ?? item?.put;
            const content = operation?.requestBody?.content ?? {};
            // Sending JSON to a `multer` route means no file and a server-side
            // failure the client cannot explain.
            expect(Object.keys(content)).toEqual(["multipart/form-data"]);
        }
    });

    it("documents the payment webhook without session or CSRF security", () => {
        // A provider callback cannot present a cookie or a CSRF token, so
        // declaring security here would be a lie that generates a broken client.
        const item = specPaths["/api/payments/notification"] as
            | { post?: { security?: unknown[]; description?: string } }
            | undefined;
        expect(item?.post?.security).toBeUndefined();
        // And it must say how it is authenticated instead.
        expect(item?.post?.description).toMatch(/signature/i);
    });
});
