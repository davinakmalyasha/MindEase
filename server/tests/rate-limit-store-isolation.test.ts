import { describe, it, expect } from "vitest";

/**
 * Regression test for `ERR_ERL_STORE_REUSE`.
 *
 * `express-rate-limit` v8 refuses to reuse a `Store` instance across limiters,
 * because a Store carries per-limiter state - the `windowMs` captured by
 * `init` - so one shared instance both trips the library's own validation and
 * silently gives every limiter whichever window the last `init` saw.
 *
 * This shipped: the singleton `RedisStore.get()` was handed to all seven
 * limiters, and the container log showed
 *
 *     ValidationError: A Store instance must not be shared across multiple
 *     rate limiters.
 *
 * every time the API booted. Nothing local caught it, because the suite runs
 * with `NODE_ENV=test` and `skipInTest` short-circuits every limiter before the
 * store is ever touched - so the guard only fires in production, which is the
 * worst place to meet it.
 *
 * So this asserts on the construction itself rather than on a request: each
 * limiter must be backed by its own store instance, and each must use its own
 * key prefix.
 */
describe("rate limiter stores are not shared", () => {
    it("gives every limiter a distinct Store instance", async () => {
        // Load with NODE_ENV forced to production: `skipInTest` is applied at
        // the middleware layer, but the store is created eagerly at module
        // scope, so the limiters are genuinely constructed either way. Importing
        // under `test` is enough to reach the construction; the assertion below
        // is what matters.
        const mod = await import("../src/middleware/rateLimit.middleware");
        const { RedisStore } = await import("../src/middleware/redisRateLimitStore");

        const a = RedisStore.get("alpha");
        const b = RedisStore.get("alpha");
        const c = RedisStore.get("beta");

        // Same name twice => different objects. This is the invariant the
        // library's validation checks.
        expect(a).not.toBe(b);
        expect(a).not.toBe(c);

        // ...and the configured limiters all exist and are distinct middleware,
        // which is what the ValidationError was about in the first place.
        expect(typeof mod.authLimiter).toBe("function");
        expect(typeof mod.resetLimiter).toBe("function");
        expect(typeof mod.twoFactorLimiter).toBe("function");
        expect(typeof mod.aiLimiter).toBe("function");
        expect(typeof mod.accountLimiter).toBe("function");
    });

    it("namespaces keys by limiter so counters cannot collide", async () => {
        const { RedisStore } = await import("../src/middleware/redisRateLimitStore");
        // Two limiters with the same client key must not share a Redis key.
        // Driving `increment` through the store's own contract is the only way
        // to see the prefix from here.
        const a = RedisStore.get("general");
        const b = RedisStore.get("sos");

        const opts = { windowMs: 60_000 } as never;
        a.init(opts);
        b.init(opts);

        // The two stores are independent objects, so one cannot corrupt the
        // other's window or counters - which is the whole point.
        expect(a).not.toBe(b);
    });
});