import { createClient } from "redis";
import { logger } from "../utils/logger";

let client: ReturnType<typeof createClient> | null = null;
let connectPromise: Promise<ReturnType<typeof createClient> | null> | null = null;
let lastAttempt = 0;
const RETRY_COOLDOWN_MS = 60_000;

const getClient = async (): Promise<ReturnType<typeof createClient> | null> => {
    if (client?.isOpen) return client;
    if (connectPromise) return connectPromise;
    if (Date.now() - lastAttempt < RETRY_COOLDOWN_MS) return null;

    lastAttempt = Date.now();
    connectPromise = (async () => {
        const url = process.env.REDIS_URL || "redis://localhost:6379";
        // RESP2 (no HELLO) for compatibility with older Redis servers.
        const c = createClient({ url });
        c.on("error", (err: any) => {
            logger.warn({ err: err.message }, "Redis cache error — cache disabled");
        });
        try {
            await c.connect();
            client = c;
            logger.info("Connected to Redis (cache)");
        } catch (err: any) {
            logger.warn({ err: err.message }, "Redis cache unavailable — cache disabled");
            client = null;
        }
        return client;
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
 * Distributed lock for cron jobs: only one runner acquires the key until the
 * TTL expires. Returns true when acquired, false when another replica holds
 * it. Fails open (returns true) when Redis is down — single-replica setups
 * are unaffected and multi-replica duplicates degrade to the old behavior.
 */
export const acquireLock = async (key: string, ttlSeconds = 600): Promise<boolean> => {
    try {
        const c = await getClient();
        if (!c) return true;
        const res = await c.set(`lock:${key}`, "1", { NX: true, EX: ttlSeconds });
        return res === "OK";
    } catch {
        return true;
    }
};
