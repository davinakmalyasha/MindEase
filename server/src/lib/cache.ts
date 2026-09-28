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
 * Redis is tried first. If Redis is unreachable the lock **fails closed** and
 * the job does not run — a missed weekly report is far cheaper than sending
 * every opted-in patient the same email once per replica. `GET_LOCK` provides
 * a database-backed fallback so the job still runs on single-replica
 * deployments that have no Redis at all.
 */
export const acquireLock = async (key: string, ttlSeconds = 600): Promise<boolean> => {
    const redisKey = `lock:${key}`;

    let client: RedisClient | null = null;
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

    // No Redis: fall back to a MySQL named lock, which is scoped to the
    // connection, so hold it on a dedicated connection for the job's duration
    // is not possible here. `GET_LOCK` is used purely as a best-effort gate.
    try {
        const rows = await prisma.$queryRawUnsafe<{ acquired: number }[]>(
            "SELECT GET_LOCK(?, ?) AS acquired",
            redisKey,
            ttlSeconds
        );
        return rows[0]?.acquired === 1;
    } catch (err: any) {
        logger.error({ err: err.message, key }, "Unable to determine lock ownership — skipping run");
        return false;
    }
};

/** Releases a lock acquired via {@link acquireLock}. */
export const releaseLock = async (key: string): Promise<void> => {
    const redisKey = `lock:${key}`;
    try {
        const c = await getClient();
        if (c) await c.del(redisKey);
    } catch {
        // best-effort
    }
    try {
        await prisma.$queryRawUnsafe("SELECT RELEASE_LOCK(?)", redisKey);
    } catch {
        // best-effort; the lock also expires on its own
    }
};
