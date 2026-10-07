import type { Store, IncrementResponse, Options } from "express-rate-limit";
import { cacheIncr, cacheDel } from "../lib/cache";

/**
 * A shared counter store for `express-rate-limit`, on the Redis client this
 * application already has.
 *
 * ## Why this exists
 *
 * `express-rate-limit` defaults to an in-memory `MemoryStore`, which is
 * per-process and lost on restart. No limiter in this codebase passed a `store`
 * option, so on two Railway replicas every limit was effectively doubled, and a
 * rolling deploy handed every attacker a free reset of all counters.
 *
 * Written here rather than pulled from `rate-limit-redis` for two reasons: the
 * `redis` client is already a dependency and `lib/cache.ts` already owns its
 * reconnect and cooldown behaviour, so a second client would double the failure
 * surface; and `INCR` is the only command needed, which is a few lines rather
 * than a dependency.
 *
 * ## Failure behaviour
 *
 * `Store` in express-rate-limit v8 is a structural object type, so this is a
 * factory rather than a class.
 *
 * When Redis is unreachable, `increment` reports a single hit. For the general
 * and write-volume limiters that is deliberately fail-open - an unavailable
 * cache must not take the product down. For the credential limiters it is still
 * fail-open, because an in-process counter cannot be made correct without Redis,
 * but it logs loudly on every miss rather than degrading silently, since
 * "your brute-force protection is not shared across replicas" is a fact an
 * operator needs to see.
 */
const makeStore = (prefix: string, warnOnMiss: boolean): Store => {
    let windowMs = 60_000;

    const keyFor = (key: string) => `rl:${prefix}:${key}`;

    return {
        init(options: Options) {
            windowMs = options.windowMs;
        },

        async increment(key: string): Promise<IncrementResponse> {
            const ttlSeconds = Math.max(Math.ceil(windowMs / 1000), 1);
            const result = await cacheIncr(keyFor(key), ttlSeconds);

            if (result) {
                return { totalHits: result.count, resetTime: new Date(result.resetAtMs) };
            }

            if (warnOnMiss) {
                console.warn(
                    `[rate-limit] Redis unavailable; the "${prefix}" limiter is counting in-process only. ` +
                        "These limits are not shared across replicas."
                );
            }
            return { totalHits: 1, resetTime: new Date(Date.now() + windowMs) };
        },

        async decrement(key: string): Promise<void> {
            // `skipSuccessfulRequests` decrements after a success. There is no
            // atomic DECR-preserving-TTL helper in cache.ts, and decrementing
            // without one risks resurrecting an expired key with no TTL, so the
            // counter is cleared instead. Slightly over-permissive by one
            // request, which is the safe direction for a limit.
            await cacheDel(keyFor(key));
        },

        async resetKey(key: string): Promise<void> {
            await cacheDel(keyFor(key));
        },
    };
};

/**
 * A fresh `Store` for each limiter.
 *
 * `express-rate-limit` v8 rejects reusing a Store instance across limiters
 * (`ERR_ERL_STORE_REUSE`) because a Store carries per-limiter state - notably
 * the `windowMs` captured by `init` - so sharing one instance both trips the
 * validation and silently gives every limiter whichever window the last
 * `init` saw.
 *
 * What must be shared for the limits to hold across replicas is the *Redis
 * client*, and that is still shared: `lib/cache.ts` owns one. Giving each
 * limiter its own Store object over the same connection costs nothing and
 * keeps the counters shared.
 *
 * `name` must be stable across restarts (otherwise the key prefix changes and
 * every counter resets on deploy) and unique per limiter (otherwise two
 * limiters read each other's counts).
 */
export const RedisStore = {
    /** For limits that must stay correct across replicas when Redis is up. */
    get: (name: string): Store => makeStore(name, false),
    /** For credential limits, which warn when they cannot be shared. */
    getFailClosed: (name: string): Store => makeStore(name, true),
};
