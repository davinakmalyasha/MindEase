import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import { Request, RequestHandler } from "express";
import { RedisStore } from "./redisRateLimitStore";

// Disables a limiter under NODE_ENV=test (integration tests share one IP).
export const skipInTest = (mw: RequestHandler): RequestHandler =>
    process.env.NODE_ENV === "test" ? (_req, _res, next) => next() : mw;

/**
 * The shared counter store.
 *
 * `express-rate-limit` defaults to an in-memory `MemoryStore`, which is
 * per-process and lost on restart. No limiter here passed a `store` option, so
 * on two Railway replicas every limit below was effectively doubled and a
 * rolling deploy handed every attacker a free reset of all counters. `redis` is
 * already a runtime dependency and `lib/cache.ts` already owns the reconnect
 * behaviour, so the store is built on that client rather than a second one.
 *
 * `failClosed` selects the *credential* variant, which warns loudly when Redis
 * is unavailable. For the general and AI limits a cache outage must not take the
 * site down, so those fail open silently - see `redisRateLimitStore.ts` for the
 * reasoning.
 */
const store = (failClosed = false): Store =>
    failClosed ? RedisStore.getFailClosed() : RedisStore.get();

const base = (failClosed = false) => ({
    standardHeaders: true as const,
    legacyHeaders: false as const,
    store: store(failClosed),
});

/**
 * The only supported way to construct a limiter in this codebase.
 *
 * Two limiters were built with a bare `rateLimit({...})` and so silently got
 * `MemoryStore` - the exact defect the comment above describes - while
 * `docs/security.md` listed all seven as Redis-backed. A per-process 300/15min
 * global ceiling is doubled on two replicas and resets on every rolling deploy.
 *
 * So the configuration is now behind a function whose only job is to make the
 * store impossible to forget, and `tests/rate-limit-store.test.ts` greps `src/`
 * to prove no bare `rateLimit({` exists anywhere.
 */
/**
 * The only supported way to construct a limiter in this codebase.
 *
 * Two limiters were built with a bare `rateLimit({...})` and so silently got
 * `MemoryStore` - the exact defect the comment above describes - while
 * `docs/security.md` listed all seven as Redis-backed. A per-process 300/15min
 * global ceiling is doubled on two replicas and resets on every rolling deploy.
 * Two more (`supportLimiter` and `sosLimiter`, in `routes/support.routes.ts`)
 * had the same problem, and the SOS one matters most: its bound is a safety
 * ceiling, so a person in distress pressing the button again was counted twice
 * over.
 *
 * So the configuration is now behind a function whose only job is to make the
 * store impossible to forget, and `tests/rate-limit-store.test.ts` greps `src/`
 * to prove no bare `rateLimit({` exists anywhere.
 *
 * Typed as `Parameters<typeof rateLimit>[0]` rather than by naming the
 * library's `Options`: `Options` requires `standardHeaders` and
 * `legacyHeaders`, which `base()` supplies, and restating a third party's type
 * here means this file breaks on their next major. Deriving it from the
 * function cannot drift.
 */
type LimiterConfig = Parameters<typeof rateLimit>[0];

export const sharedLimiter = (config: LimiterConfig, failClosed = false) =>
    rateLimit({ ...base(failClosed), ...config });

/**
 * Login and registration, per IP.
 *
 * `skipSuccessfulRequests` so the budget is spent on *failures*. Without it, a
 * shared egress IP - office NAT, a corporate proxy, carrier CGNAT - could
 * exhaust the bucket with 20 anonymous attempts from a third party and lock a
 * real user out for the rest of the window.
 */
export const authLimiter = sharedLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    skipSuccessfulRequests: true,
    message: {
        status: "error",
        message: "Too many login attempts, please try again after 15 minutes",
    },
});

/**
 * Password reset and email verification, per IP.
 *
 * A separate instance from login. They used to share one module-level limiter,
 * so twenty attempts against *any* of register / login / forgot-password /
 * reset-password / verify-email / 2fa-verify exhausted the same bucket - which
 * let an anonymous attacker deny a victim the ability to log in, to reset a
 * forgotten password, or to complete 2FA, in a mental-health product, for
 * fifteen minutes, for the cost of twenty requests.
 */
export const resetLimiter = sharedLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {
        status: "error",
        message: "Too many attempts, please try again after 15 minutes",
    },
});

/** Two-factor verification. Separate again, for the same reason. */
export const twoFactorLimiter = sharedLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {
        status: "error",
        message: "Too many verification attempts, please try again after 15 minutes",
    },
});

// Guards paid AI calls (Gemini) against cost abuse - 15 generation requests
// per 10 minutes per IP.
export const aiLimiter = sharedLimiter({
    windowMs: 10 * 60 * 1000,
    max: 15,
    message: {
        status: "error",
        message: "Too many AI requests, please try again later",
    },
});

/**
 * Per-account brute-force protection for credential checks.
 *
 * Keyed by email when present, so one account cannot be hammered from a shared
 * NAT, and falls back to IP otherwise.
 *
 * On the 2FA route this used to fall through to the IP key, because that
 * endpoint posts `{token, code}` and has no `email` field - so a phished
 * password plus a `twoFactorToken` let an attacker brute-force the 6-digit TOTP
 * at the per-IP allowance from rotating addresses, against a code with a
 * ~1-in-a-million chance per guess. The key now falls back to the pending
 * token, which is stable for one login attempt, so the counter applies.
 */
export const accountLimiter = sharedLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => {
        const body = (req.body ?? {}) as { email?: string; token?: string };
        const email = (body.email || "").trim().toLowerCase();
        if (email) return email;
        const token = (body.token || "").trim();
        if (token) return `2fa:${token}`;
        return ipKeyGenerator(req.ip || "unknown", 32);
    },
    message: {
        status: "error",
        message: "Too many attempts for this account, please try again after 15 minutes",
    },
});

/**
 * Authenticated write volume, keyed on the user id in the session.
 *
 * Not IP-keyed: a per-IP limit on `POST /messages` is defeated by one account
 * behind one address, which is the normal case.
 */
export const perUserWriteLimiter = (
    max: number,
    windowMs: number,
    what: string
): RequestHandler => {
    const limiter = sharedLimiter({
        windowMs,
        max,
        keyGenerator: (req) => {
            const id = (req as Request & { user?: { id?: number } }).user?.id;
            // Before `authenticate` has run there is no user, so fall back to
            // the IP rather than keying everything under `undefined`.
            return id ? `u${id}` : ipKeyGenerator(req.ip || "unknown", 32);
        },
        message: {
            status: "error",
            message: `Too many ${what} requests, please slow down`,
        },
    });
    return skipInTest(limiter);
};
