import { createClient } from "redis";
import { logger } from "../utils/logger";

/**
 * The concrete client type the redis package infers for a plain `createClient`
 * call. The bare `RedisClientType` alias from the package collides with the
 * module's own generic parameters under `strict`.
 */
type RedisClient = ReturnType<typeof createClient>;

/**
 * The Go realtime service subscribes to this channel and fans events out over
 * WebSocket, so a publish here is what makes an SOS or a chat message appear
 * instantly in the browser.
 */
const EVENT_CHANNEL = "mindease:events";

/** Bounded connect deadline: never hold a request open on a dead Redis. */
const CONNECT_TIMEOUT_MS = 1_500;
const RETRY_COOLDOWN_MS = 30_000;

let publisher: RedisClient | null = null;
let connectPromise: Promise<RedisClient | null> | null = null;
let lastAttempt = 0;

const getPublisher = async (): Promise<RedisClient | null> => {
    if (publisher?.isOpen) return publisher;
    if (connectPromise) return connectPromise;
    if (Date.now() - lastAttempt < RETRY_COOLDOWN_MS) return null;

    lastAttempt = Date.now();
    connectPromise = (async () => {
        // Tear down a client left over from a dropped connection so sockets are
        // not leaked on every retry.
        if (publisher) {
            publisher.removeAllListeners();
            publisher.disconnect().catch(() => undefined);
            publisher = null;
        }

        const url = process.env.REDIS_URL || "";
        if (!url) {
            logger.debug("REDIS_URL not set — realtime events disabled");
            return null;
        }

        try {
            // RESP2 (no HELLO) for compatibility with older Redis servers.
            const client = createClient({
                url,
                socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
            });
            client.on("error", (err: any) => {
                logger.warn({ err: err.message }, "Redis error — realtime events disabled");
            });

            await Promise.race([
                client.connect(),
                new Promise((_resolve, reject) =>
                    setTimeout(() => reject(new Error("Redis connect timed out")), CONNECT_TIMEOUT_MS)
                ),
            ]);

            publisher = client;
            logger.info("Connected to Redis (realtime publisher)");
            return client;
        } catch (err: any) {
            logger.warn({ err: err.message }, "Redis unavailable — realtime events disabled");
            return null;
        }
    })();

    const result = await connectPromise;
    connectPromise = null;
    return result;
};

/**
 * The complete vocabulary of events pushed to a connected client.
 *
 * This was a bare `string`, so nothing stopped a new call site inventing a
 * typo'd type that silently never reached a handler. Every value below is
 * published from at least one `publishEvent` call; `tests/realtime-contract.test.ts`
 * asserts that correspondence, so adding a type here without a publisher (or
 * publishing a type absent here) fails the suite.
 */
export type RealtimeEventType =
    | "message:new"
    | "message:read"
    | "message:deleted"
    | "message:reacted"
    | "typing:start"
    | "typing:stop"
    | "appointment:join"
    | "notification:new"
    | "sos:alert"
    | "risk:alert";

export interface RealtimeEvent {
    type: RealtimeEventType;
    payload?: Record<string, any>;
}

// Publishes an event for a user; the Go realtime service pushes it over WebSocket.
export const publishEvent = async (userId: number, event: RealtimeEvent) => {
    if (process.env.NODE_ENV === "test") return; // tests use REST + polling
    try {
        const client = await getPublisher();
        if (!client) return;
        await client.publish(
            EVENT_CHANNEL,
            JSON.stringify({ userId, type: event.type, payload: event.payload ?? null })
        );
    } catch (err: any) {
        logger.warn({ err: err.message }, "Failed to publish realtime event");
    }
};

export const closePublisher = async () => {
    const current = publisher;
    publisher = null;
    if (current?.isOpen) {
        await current.quit().catch(() => undefined);
    }
};

export const notifyUser = (userId: number, title: string, message: string, type = "system") => {
    return publishEvent(userId, {
        type: "notification:new",
        payload: { title, message, type, createdAt: new Date().toISOString() },
    });
};
