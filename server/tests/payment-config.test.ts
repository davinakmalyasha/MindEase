import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

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

/**
 * The shipped `.env.example` is an input to production.
 *
 * These read the real file rather than a copy, because the whole failure was
 * that a hardcoded list of "known weak" strings and the values in the template
 * were maintained independently of each other. The template shipped
 * `change_me_access_secret` - 23 characters, not in KNOWN_WEAK, not `dev_`
 * prefixed - so it passed all three production checks and `cp .env.example .env`
 * followed by a deploy produced an API that signed every token in the product
 * with a string published in this repository.
 *
 * A test that pins the template makes the two impossible to disagree again.
 */
describe("the shipped .env.example", () => {
    const TEMPLATE = fs.readFileSync(
        path.resolve(__dirname, "..", "..", ".env.example"),
        "utf8"
    );

    /** Active (uncommented) assignments only, so the documented examples do not count. */
    const activeValue = (name: string): string | undefined => {
        const m = TEMPLATE.match(new RegExp(`^${name}=(.*)$`, "m"));
        return m ? m[1].trim() : undefined;
    };

    const SIGNING_SECRETS = ["JWT_SECRET", "REFRESH_SECRET", "TWO_FACTOR_SECRET"];

    it("ships all three signing secrets as placeholders, not as usable values", () => {
        for (const name of SIGNING_SECRETS) {
            const value = activeValue(name);
            expect(value, `${name} must be present in .env.example`).toBeDefined();
            // The `dev_` prefix is what the production validator rejects, so a
            // template value carrying it fails the boot loudly instead of
            // quietly signing tokens with a published string.
            expect(
                value!.startsWith("dev_"),
                `${name} must be dev_-prefixed so production refuses it`
            ).toBe(true);
        }
    });

    it("uses three different placeholder values", () => {
        const values = SIGNING_SECRETS.map(activeValue);
        expect(new Set(values).size).toBe(SIGNING_SECRETS.length);
    });

    it.each(SIGNING_SECRETS)("is refused by the production validator as %s", async (name) => {
        // The end-to-end version of the regression: paste the template's own
        // value into a production boot and it must refuse.
        await expect(
            loadEnv({
                NODE_ENV: "production",
                PAYMENT_PROVIDER: "simulator",
                ALLOW_PAYMENT_SIMULATOR: "true",
                [name]: activeValue(name),
            })
        ).rejects.toThrow(new RegExp(name));
    });

    it.each(SIGNING_SECRETS)("refuses the previously shipped %s placeholder too", async (name) => {
        // The old placeholders are still in this repository's history and still
        // in circulation. Being listed in KNOWN_WEAK means a deployment that
        // copied .env.example before this change fails rather than runs.
        const legacy = {
            JWT_SECRET: "change_me_access_secret",
            REFRESH_SECRET: "change_me_refresh_secret",
            TWO_FACTOR_SECRET: "change_me_two_factor_secret",
        }[name]!;
        await expect(
            loadEnv({
                NODE_ENV: "production",
                PAYMENT_PROVIDER: "simulator",
                ALLOW_PAYMENT_SIMULATOR: "true",
                [name]: legacy,
            })
        ).rejects.toThrow(new RegExp(name));
    });
});
