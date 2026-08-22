import { createClient } from "redis";
import { logger } from "../utils/logger";

const EVENT_CHANNEL = "mindease:events";

let publisher: ReturnType<typeof createClient> | null = null;
let connectPromise: Promise<ReturnType<typeof createClient> | null> | null = null;

const getPublisher = async (): Promise<ReturnType<typeof createClient> | null> => {
    if (publisher?.isOpen) return publisher;

    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
        const url = process.env.REDIS_URL || "redis://localhost:6379";
        // RESP2 (no HELLO) for compatibility with older Redis servers.
        const client = createClient({ url });
        client.on("error", (err: any) => {
            logger.warn({ err: err.message }, "Redis error — realtime events disabled");
        });

        try {
            await client.connect();
            publisher = client;
            logger.info("Connected to Redis (realtime publisher)");
        } catch (err: any) {
            logger.warn({ err: err.message }, "Redis unavailable — realtime events disabled");
            publisher = null;
        }
        return publisher;
    })();

    const result = await connectPromise;
    connectPromise = null;
    return result;
};

export interface RealtimeEvent {
    type: string;
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

export const notifyUser = (userId: number, title: string, message: string, type = "system") => {
    return publishEvent(userId, {
        type: "notification:new",
        payload: { title, message, type, createdAt: new Date().toISOString() },
    });
};
