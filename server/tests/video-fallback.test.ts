import { describe, it, expect, afterAll, vi } from "vitest";
import jwt from "jsonwebtoken";

/**
 * The unauthenticated video fallback, and the honesty of the degraded flag.
 *
 * The rest of the suite runs with `VIDEO_PROVIDER=livekit`, which is the
 * production configuration - see `tests/global-setup.ts`. That leaves the jitsi
 * branch untested, and it is the branch that matters most to reason about: it
 * is the one that puts a therapy session on somebody else's public
 * infrastructure with no credential at all, and the whole reason
 * `ARCHITECTURE.md` and the privacy policy make a point of disclosing it.
 *
 * A degraded provider that reports itself as healthy is worse than no
 * disclosure at all, so the assertions here are about the flag as much as
 * about the URL.
 *
 * `config/env.ts` snapshots process.env at module evaluation, so this file
 * cannot reconfigure the provider with an ordinary assignment. `vi.resetModules`
 * plus a dynamic import is the supported way to get a freshly evaluated
 * `env`/`video.service` pair, and it is why this is a separate file rather than
 * a `describe` block inside `video-token.test.ts`.
 */

type Grant = {
    provider: string;
    degraded: boolean;
    reason?: string;
    room: string;
    token?: string;
    identity: string;
};

/** Loads the video service against a specific environment, from scratch. */
const loadService = async (overrides: Record<string, string | undefined>) => {
    vi.resetModules();
    const original: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(overrides)) {
        original[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    // Imported after the environment is in place, deliberately.
    const mod = await import("../src/services/video.service");
    return {
        buildGrant: mod.buildGrant as (input: {
            appointmentId: number;
            userId: number;
            displayName: string;
            validUntilMs: number;
            roomSeed: string;
        }) => Grant,
        activeProvider: mod.activeProvider as () => { provider: string; degraded: boolean; reason?: string },
        restore: () => {
            for (const [key, value] of Object.entries(original)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            vi.resetModules();
        },
    };
};

const GRANT_INPUT = {
    appointmentId: 4242,
    userId: 77,
    displayName: "E2E Fallback",
    validUntilMs: Date.now() + 60 * 60_000,
    roomSeed: "fixedseed",
};

describe("video provider fallback", () => {
    afterAll(() => {
        vi.resetModules();
    });

    it("reports degraded, with a reason, when livekit is asked for but not configured", async () => {
        const svc = await loadService({
            VIDEO_PROVIDER: "livekit",
            LIVEKIT_URL: undefined,
            LIVEKIT_API_KEY: undefined,
            LIVEKIT_API_SECRET: undefined,
        });
        try {
            const active = svc.activeProvider();
            // The important half: `degraded` must be true. The original code
            // returned `degraded: false` for any provider value it did not
            // recognise, which meant a typo in VIDEO_PROVIDER served an
            // unauthenticated third-party room while telling the client - and
            // the banner the client renders - that the session was fine.
            expect(active.provider).toBe("jitsi");
            expect(active.degraded).toBe(true);
            expect(active.reason).toMatch(/LIVEKIT/);

            const grant = svc.buildGrant(GRANT_INPUT);
            expect(grant.provider).toBe("jitsi");
            expect(grant.room).toContain("https://meet.jit.si/");
        } finally {
            svc.restore();
        }
    });

    it("treats a half-configured livekit as degraded rather than as an error", async () => {
        const svc = await loadService({
            VIDEO_PROVIDER: "livekit",
            LIVEKIT_URL: "wss://livekit.example.com",
            LIVEKIT_API_KEY: "APItestkey",
            LIVEKIT_API_SECRET: undefined,
        });
        try {
            // Two of three credentials is not a configuration, it is a
            // half-finished deploy. Failing closed to the documented fallback
            // is better than throwing inside a consultation join.
            expect(svc.activeProvider()).toMatchObject({ provider: "jitsi", degraded: true });
        } finally {
            svc.restore();
        }
    });

    it("issues no token on the jitsi path, because there is nothing to issue", async () => {
        const svc = await loadService({
            VIDEO_PROVIDER: "jitsi",
            LIVEKIT_URL: undefined,
            LIVEKIT_API_KEY: undefined,
            LIVEKIT_API_SECRET: undefined,
        });
        try {
            // `degraded` is a property of the *configuration*, not of the grant,
            // so it is read from `activeProvider`. The distinction between "you
            // chose this" and "this happened to you" is the whole point of the
            // flag, and it is why the two are separate functions.
            const active = svc.activeProvider();
            expect(active).toMatchObject({ provider: "jitsi", degraded: false });

            const grant = svc.buildGrant(GRANT_INPUT);
            expect(grant.provider).toBe("jitsi");
            expect(grant.token).toBeUndefined();
            expect(grant.room).toMatch(/^https:\/\/meet\.jit\.si\/MindEase-4242-[0-9a-f]{16}$/);
        } finally {
            svc.restore();
        }
    });

    it("keeps the livekit path authenticated and the room opaque", async () => {
        const svc = await loadService({
            VIDEO_PROVIDER: "livekit",
            LIVEKIT_URL: "wss://livekit.example.com",
            LIVEKIT_API_KEY: "APItestkey",
            LIVEKIT_API_SECRET: "test-livekit-secret-value-0000",
        });
        try {
            expect(svc.activeProvider()).toMatchObject({ provider: "livekit", degraded: false });

            const grant = svc.buildGrant(GRANT_INPUT);
            expect(grant.provider).toBe("livekit");
            expect(grant.room).not.toMatch(/^https?:/);
            expect(grant.room).toContain("4242");
            expect(grant.room).toContain("fixedseed");

            // The token is real, room-scoped, and contains no secret.
            const claims = jwt.decode(grant.token!) as Record<string, unknown>;
            expect((claims.video as { room: string }).room).toBe(grant.room);
            expect(grant.token).not.toContain("test-livekit-secret-value-0000");
        } finally {
            svc.restore();
        }
    });
});
