import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Payment configuration is fail-closed on purpose: a deployment must never
 * quietly take money through a fake gateway or hand out free entitlements.
 *
 * These tests exercise the config module directly by resetting it between
 * cases, because `env.ts` reads `process.env` once at import time.
 */

const ORIGINAL = { ...process.env };

/** Everything env.ts requires in production, so each case isolates payments only. */
const PRODUCTION_BASELINE = {
    JWT_SECRET: "test-jwt-secret-000000000000000000000000",
    REFRESH_SECRET: "test-refresh-secret-1111111111111111",
    TWO_FACTOR_SECRET: "test-twofactor-secret-222222222222",
    FRONTEND_URL: "http://localhost:3000",
    DATABASE_URL: "mysql://root:@127.0.0.1:3306/mindease_f",
};

/** Import a fresh copy of the config module with the given environment. */
const loadEnv = async (vars: Record<string, string | undefined>) => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIGINAL, PRODUCTION_BASELINE, vars);

    vi.resetModules();
    return await import("../src/config/env");
};

describe("payment configuration", () => {
    beforeEach(() => {
        // Isolate from the ambient environment.
        delete process.env.PAYMENT_PROVIDER;
        delete process.env.PAYMENT_SERVER_KEY;
        delete process.env.PAYMENT_CLIENT_KEY;
        delete process.env.PAYMENT_BASE_URL;
        delete process.env.ALLOW_PAYMENT_SIMULATOR;
    });

    afterEach(() => {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, ORIGINAL);
        vi.resetModules();
    });

    it("rejects an unknown provider instead of falling back to the simulator", async () => {
        // The bug: `provider as "midtrans" | "simulator"` accepted anything, and
        // getPaymentProvider resolves every non-"midtrans" value to the
        // simulator — so a typo booted cleanly and served fake checkouts.
        await expect(
            loadEnv({ NODE_ENV: "production", PAYMENT_PROVIDER: "midtranss", PAYMENT_SERVER_KEY: "k" })
        ).rejects.toThrow(/not a known provider/);
    });

    it("rejects production boot with no payment credentials", async () => {
        await expect(loadEnv({ NODE_ENV: "production" })).rejects.toThrow(
            /PAYMENT_PROVIDER and PAYMENT_SERVER_KEY are required/
        );
    });

    it("rejects an explicit simulator in production", async () => {
        // A key must be present to reach the simulator-specific check: without
        // one, the "credentials are required" guard fires first.
        await expect(
            loadEnv({ NODE_ENV: "production", PAYMENT_PROVIDER: "simulator", PAYMENT_SERVER_KEY: "k" })
        ).rejects.toThrow(/not permitted in production/);
    });

    it("reports missing credentials before judging the provider name", async () => {
        // Ordering matters for the operator's diagnosis: a bare simulator with
        // no key is a missing-credentials problem, not a policy violation.
        await expect(
            loadEnv({ NODE_ENV: "production", PAYMENT_PROVIDER: "simulator" })
        ).rejects.toThrow(/PAYMENT_PROVIDER and PAYMENT_SERVER_KEY are required/);
    });

    it("allows the simulator in production only via the explicit opt-in", async () => {
        // This is what `docker compose up` relies on: the image runs with
        // NODE_ENV=production but must boot without a merchant account.
        const env = await loadEnv({
            NODE_ENV: "production",
            PAYMENT_PROVIDER: "simulator",
            ALLOW_PAYMENT_SIMULATOR: "true",
        });
        expect(env.env.payments.mode).toBe("simulator");
    });

    it("allows the simulator in production when credentials are simply absent, with the opt-in", async () => {
        const env = await loadEnv({ NODE_ENV: "production", ALLOW_PAYMENT_SIMULATOR: "true" });
        expect(env.env.payments.mode).toBe("simulator");
    });

    it("defaults to the simulator outside production", async () => {
        const env = await loadEnv({ NODE_ENV: "development" });
        expect(env.env.payments.mode).toBe("simulator");
    });

    it("resolves real midtrans credentials to the midtrans mode", async () => {
        const env = await loadEnv({
            NODE_ENV: "production",
            PAYMENT_PROVIDER: "MidTrans", // case/whitespace tolerant
            PAYMENT_SERVER_KEY: "server-key",
            PAYMENT_CLIENT_KEY: "client-key",
        });
        expect(env.env.payments.mode).toBe("midtrans");
        expect(env.env.payments.serverKey).toBe("server-key");
        expect(env.env.payments.baseUrl).toBe("https://app.midtrans.com");
    });

    it("still enforces the other production secrets", async () => {
        // Guards against the payment refactor accidentally relaxing the
        // REFRESH_SECRET !== JWT_SECRET rule.
        await expect(
            loadEnv({
                NODE_ENV: "production",
                PAYMENT_PROVIDER: "simulator",
                ALLOW_PAYMENT_SIMULATOR: "true",
                JWT_SECRET: "same-secret-value-000000000000000",
                REFRESH_SECRET: "same-secret-value-000000000000000",
            })
        ).rejects.toThrow(/REFRESH_SECRET/);
    });
});
