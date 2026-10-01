import { describe, expect, it, vi, afterEach } from "vitest";

/**
 * Video configuration is fail-loud on an unknown provider.
 *
 * `jitsi` is a deliberate, disclosed fallback: a deployment with no LiveKit
 * credentials still gets a consultation room, and the API says so on every
 * join. What it must never do is reach that fallback *by accident*. The old
 * line was a bare `as` cast, so a typo booted cleanly and returned
 * `degraded: false` - serving an unauthenticated public room while telling the
 * client the session was fine.
 *
 * The payments validator hit the identical bug first; `payment-config.test.ts`
 * records it. This file is the same shape, pointed at the worse case.
 *
 * The config module reads `process.env` once at import time, so each case
 * resets the module registry and re-imports it.
 */

const ORIGINAL = { ...process.env };

/**
 * Everything env.ts requires in production, so each case isolates video only.
 *
 * The payment block is evaluated before the video block and refuses to boot in
 * production without a provider and a server key, so a real-looking Midtrans
 * pair has to be present for any `NODE_ENV=production` case to reach the video
 * validator at all. Satisfying an unrelated provider's requirements is the
 * price of exercising the production-only branches.
 */
const PRODUCTION_BASELINE = {
    JWT_SECRET: "test-jwt-secret-000000000000000000000000",
    REFRESH_SECRET: "test-refresh-secret-1111111111111111",
    TWO_FACTOR_SECRET: "test-twofactor-secret-222222222222",
    FRONTEND_URL: "http://localhost:3000",
    DATABASE_URL: "mysql://root:@127.0.0.1:3306/mindease_f",
    PAYMENT_PROVIDER: "midtrans",
    PAYMENT_SERVER_KEY: "test-payment-server-key",
    PAYMENT_CLIENT_KEY: "test-payment-client-key",
};

/**
 * The variables under test, removed from the ambient environment.
 *
 * `tests/global-setup.ts` sets VIDEO_PROVIDER=livekit for the whole suite, and
 * `server/.env` is loaded into process.env by the time this module is
 * evaluated. Restoring a raw `ORIGINAL` would therefore re-inject the value
 * being tested and every "absent variable defaults to" case would assert
 * against livekit.
 */
const UNDER_TEST = [
    "VIDEO_PROVIDER",
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
] as const;

const CLEAN_ORIGINAL: Record<string, string | undefined> = { ...ORIGINAL };
for (const key of UNDER_TEST) delete CLEAN_ORIGINAL[key];

/** Import a fresh copy of the config module with the given environment. */
const loadEnv = async (vars: Record<string, string | undefined>) => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, CLEAN_ORIGINAL, PRODUCTION_BASELINE, vars);

    vi.resetModules();
    return await import("../src/config/env");
};

describe("video configuration", () => {
    afterEach(() => {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, CLEAN_ORIGINAL);
        vi.resetModules();
    });

    it("rejects an unknown provider instead of falling back to the public room", async () => {
        // The bug: `provider as "livekit" | "jitsi"` accepted anything, and
        // `activeProvider()` resolves every value that is not exactly "livekit"
        // to the unauthenticated jitsi branch - with `degraded: false`.
        await expect(loadEnv({ NODE_ENV: "production", VIDEO_PROVIDER: "livekiit" })).rejects.toThrow(
            /not a known provider/
        );
        await expect(loadEnv({ NODE_ENV: "production", VIDEO_PROVIDER: "jitsi-meet" })).rejects.toThrow(
            /not a known provider/
        );
    });

    it("defaults to jitsi when the variable is absent", async () => {
        // Not an error. A deployment that has never heard of LiveKit must still
        // be able to start a consultation; failing closed here would mean no
        // video at all, which is worse than a disclosed fallback.
        const { env } = await loadEnv({ NODE_ENV: "development" });
        expect(env.videoProvider).toBe("jitsi");
    });

    it("defaults to jitsi when the variable is only whitespace", async () => {
        const { env } = await loadEnv({ NODE_ENV: "development", VIDEO_PROVIDER: "   " });
        expect(env.videoProvider).toBe("jitsi");
    });

    it("accepts a known provider regardless of case or surrounding whitespace", async () => {
        // Deployments configure this from a dashboard field, where a stray space
        // is a much more likely mistake than a genuinely wrong name, and the
        // old code already trimmed and lowercased.
        const upper = await loadEnv({ NODE_ENV: "development", VIDEO_PROVIDER: "  LiveKit " });
        expect(upper.env.videoProvider).toBe("livekit");

        const lower = await loadEnv({ NODE_ENV: "development", VIDEO_PROVIDER: "jitsi" });
        expect(lower.env.videoProvider).toBe("jitsi");
    });

    it("exposes the livekit credentials as trimmed strings", async () => {
        const { env } = await loadEnv({
            NODE_ENV: "development",
            VIDEO_PROVIDER: "livekit",
            LIVEKIT_URL: "  wss://livekit.example.com  ",
            LIVEKIT_API_KEY: "  APIkey  ",
            LIVEKIT_API_SECRET: "  secret  ",
        });
        expect(env.livekit.url).toBe("wss://livekit.example.com");
        expect(env.livekit.apiKey).toBe("APIkey");
        expect(env.livekit.apiSecret).toBe("secret");
    });
});
