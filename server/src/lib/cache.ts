import { createClient } from "redis";
import { logger } from "../utils/logger";
import { prisma } from "./prisma";

/**
 * The concrete client type the redis package infers for a plain `createClient`
 * call. Naming it once keeps the module-level state below assignable; using the
 * bare `RedisClient` alias from the package collides with the module's own
 * generic parameters under `strict`.
 */
type RedisClient = ReturnType<typeof createClient>;

/**
 * Redis is a *cache and a pub/sub transport* in this application — never a
 * source of truth. Every read path therefore has to keep working, and keep
 * working *quickly*, when Redis is absent.
 *
 * Three properties matter, and all three are enforced here:
 *
 *  1. **Never block on a dead Redis.** `redis.connect()` on an unreachable host
 *     blocks for the full TCP connect timeout, which previously stalled the
 *     first cached request of every process for ~30 seconds. Connection
 *     attempts are now bounded by a short deadline and fail fast.
 *  2. **Self-heal.** A client that drops at runtime is discarded and rebuilt
 *     once the cooldown expires, rather than leaving realtime dead for the
 *     lifetime of the process.
 *  3. **Locks fail closed.** A lock that cannot be acquired must not be
 *     reported as acquired — otherwise every replica believes it holds the
 *     weekly-report lock and the entire opted-in user base receives the email
 *     blast.
 */
const RETRY_COOLDOWN_MS = 30_000;
/** Bounded connect deadline. Well under any plausible healthy connect time. */
const CONNECT_TIMEOUT_MS = 1_500;

let client: RedisClient | null = null;
let connectPromise: Promise<RedisClient | null> | null = null;
let lastAttempt = 0;

const discard = (stale: RedisClient | null) => {
    if (!stale) return;
    stale.removeAllListeners();
    stale.disconnect().catch(() => undefined);
};

const getClient = async (): Promise<RedisClient | null> => {
    if (client?.isOpen) return client;
    if (connectPromise) return connectPromise;
    if (Date.now() - lastAttempt < RETRY_COOLDOWN_MS) return null;

    lastAttempt = Date.now();
    connectPromise = (async () => {
        // A client left over from a dropped connection is torn down first so
        // sockets are not leaked on every retry.
        discard(client);
        client = null;

        const url = process.env.REDIS_URL || "";
        if (!url) {
            logger.debug("REDIS_URL not set — cache disabled");
            return null;
        }

        try {
            // RESP2 (no HELLO) for compatibility with older Redis servers.
            const c = createClient({
                url,
                socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
            });
            c.on("error", (err: any) => {
                logger.warn({ err: err.message }, "Redis cache error — cache disabled");
            });

            await Promise.race([
                c.connect(),
                new Promise((_resolve, reject) =>
                    setTimeout(() => reject(new Error("Redis connect timed out")), CONNECT_TIMEOUT_MS)
                ),
            ]);

            client = c;
            logger.info("Connected to Redis (cache)");
            return c;
        } catch (err: any) {
            logger.warn({ err: err.message }, "Redis cache unavailable — cache disabled");
            return null;
        }
    })();

    const result = await connectPromise;
    connectPromise = null;
    return result;
};

/** Cached read; returns null on miss or when Redis is down (graceful). */
export const cacheGet = async <T>(key: string): Promise<T | null> => {
    try {
        const c = await getClient();
        if (!c) return null;
        const raw = await c.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
};

/** TTL in seconds. Fails silently when Redis is unavailable. */
export const cacheSet = async (key: string, value: unknown, ttlSeconds = 60) => {
    try {
        const c = await getClient();
        if (!c) return;
        await c.set(key, JSON.stringify(value), { EX: ttlSeconds });
    } catch {
        // cache is best-effort
    }
};

export const cacheDel = async (...keys: string[]) => {
    try {
        const c = await getClient();
        if (!c) return;
        if (keys.length > 0) await c.del(keys);
    } catch {
        // cache is best-effort
    }
};

/**
 * Atomic increment, setting the TTL on first write.
 *
 * Exists for the shared rate-limit store, which needs a counter that two API
 * replicas increment correctly - `redis@5`'s `INCR` is atomic, so this is a
 * real shared limit rather than a per-process one.
 *
 * `null` means "Redis is not available", which is not the same as zero. The
 * caller decides what to do about it; a rate limiter that treats an unreachable
 * Redis as "no requests made yet" would fail open on every deploy that has not
 * configured it.
 */
export const cacheIncr = async (
    key: string,
    ttlSeconds: number
): Promise<{ count: number; resetAtMs: number } | null> => {
    try {
        const c = await getClient();
        if (!c) return null;

        const count = await c.incr(key);
        if (count === 1) {
            // First write in this window: give it an expiry. `NX` because a
            // concurrent replica may have set it between the INCR and here, and
            // re-setting the TTL on every hit would make a fixed window slide.
            await c.expire(key, ttlSeconds, "NX");
        }
        const ttl = await c.ttl(key);
        const resetAtMs = Date.now() + Math.max(ttl, 0) * 1000;
        return { count, resetAtMs };
    } catch {
        return null;
    }
};

/** Remaining TTL in seconds, or null when unavailable. */
export const cacheTtl = async (key: string): Promise<number | null> => {
    try {
        const c = await getClient();
        if (!c) return null;
        return await c.ttl(key);
    } catch {
        return null;
    }
};

/**
 * Coalesces concurrent cache misses for the same key onto one loader.
 *
 * Without it, a popular key expiring produces a thundering herd: every
 * in-flight request runs the same expensive query simultaneously.
 */
export const singleFlight = async <T>(key: string, loader: () => Promise<T>): Promise<T> => {
    const inFlight = singleFlight.inflight.get(key);
    if (inFlight) return inFlight as Promise<T>;

    const promise = loader()
        .catch((err) => {
            // A failed load must not poison the next caller.
            singleFlight.inflight.delete(key);
            throw err;
        })
        .finally(() => {
            if (singleFlight.inflight.get(key) === promise) {
                singleFlight.inflight.delete(key);
            }
        }) as Promise<T>;

    singleFlight.inflight.set(key, promise);
    return promise;
};
singleFlight.inflight = new Map<string, Promise<unknown>>();

/**
 * Releases the connection eagerly at shutdown so the process exits cleanly
 * instead of being killed mid-write.
 */
export const closeCache = async () => {
    const current = client;
    client = null;
    if (current?.isOpen) {
        await current.quit().catch(() => undefined);
    }
};

/**
 * Advisory lock for cron jobs: only one runner proceeds per key.
 *
 * Redis is tried first. If Redis is unreachable the lock **fails closed** and the
 * job does not run — a missed weekly report is far cheaper than sending every
 * opted-in patient the same email once per replica.
 *
 * The no-Redis fallback used to be MySQL's `GET_LOCK`, and it could not work.
 * `GET_LOCK` is scoped to the *connection*, and Prisma borrows connections from a
 * pool. The lock was taken on one connection; the job ran while that connection
 * held it; the connection then returned to the pool still holding the name; and
 * `RELEASE_LOCK` on a different borrowed connection returned NULL, so the lock
 * stayed held until the server restarted.
 *
 * The observable effect was not "the lock does not work" but something worse and
 * less legible: `runCareCheckins` either ran on every replica or stopped running
 * entirely, depending on which pooled connection the next query borrowed. Writing
 * a test for the job was impossible for the same reason — the result depended on
 * connection reuse. The old comment here admitted the fallback "cannot work as
 * written" and the callers carried on treating the lock as an optimisation, which
 * is how it survived that long.
 *
 * The fallback is now a row in `JobLock`. Acquisition is an `INSERT`, or an
 * `UPDATE ... WHERE expiresAt <= now` on an existing row; both are atomic in the
 * database, neither holds a connection open, and neither depends on a matching
 * release call - expiry is data rather than a live session, so a crashed runner
 * wedges the job for at most the TTL rather than until a restart.
 */
export const acquireLock = async (key: string, ttlSeconds = 600): Promise<boolean> => {
    const redisKey = `lock:${key}`;

    let client: RedisClient | null;
    try {
        client = await getClient();
    } catch {
        client = null;
    }

    if (client) {
        try {
            const res = await client.set(redisKey, "1", { NX: true, EX: ttlSeconds });
            return res === "OK";
        } catch {
            return false;
        }
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    try {
        // Try the row first. `create` is atomic against the primary key, so two
        // runners racing on a key that has never been used produce one winner and
        // one unique-constraint violation, rather than two winners.
        try {
            await prisma.jobLock.create({ data: { key, expiresAt } });
            return true;
        } catch (err: any) {
            // Already held by somebody. Fall through to the expiry check.
            if (err?.code !== "P2002") throw err;
        }

        // The key exists. Take it only if the current lease has run out.
        // `updateMany` with the expiry in the `where` is one atomic statement, so
        // exactly one concurrent runner sees `count === 1`.
        const taken = await prisma.jobLock.updateMany({
            where: { key, expiresAt: { lte: new Date() } },
            data: { expiresAt },
        });
        return taken.count === 1;
    } catch (err: any) {
        logger.error({ err: err.message, key }, "Unable to determine lock ownership — skipping run");
        return false;
    }
};

/**
 * Releases a lock acquired via {@link acquireLock}.
 *
 * Best-effort on the Redis path. The `JobLock` row is deliberately *not* deleted:
 * releasing a job early would defeat the TTL the lock exists to provide, and a
 * runner that crashes simply leaves the row to expire. Deleting it would also make
 * the next acquisition a `create` again, which is a second code path for no
 * benefit.
 */
export const releaseLock = async (key: string): Promise<void> => {
    const redisKey = `lock:${key}`;
    try {
        const c = await getClient();
        if (c) await c.del(redisKey);
    } catch {
        // best-effort
    }
};
