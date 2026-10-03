import webpush from "web-push";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import { badRequest } from "../utils/appError";

const IS_CONFIGURED = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

if (IS_CONFIGURED) {
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || "mailto:no-reply@mindease.app",
        process.env.VAPID_PUBLIC_KEY!,
        process.env.VAPID_PRIVATE_KEY!
    );
}

export class PushService {
    /**
     * Registers a browser endpoint for push delivery.
     *
     * Scoped by `(userId, endpoint)`, not by endpoint alone. `PushSubscription.
     * endpoint` used to be globally unique and the upsert's update branch never
     * wrote `userId`, so a second user presenting the same endpoint — a shared
     * or handed-over device, which is entirely ordinary for a family computer —
     * silently overwrote the first user's keys. The original owner then had
     * their notifications broken, and the row's owner no longer matched the keys
     * it held. `unsubscribe` was already scoped by `userId`, so the two paths
     * disagreed about who owned a row.
     *
     * A unique key on `(userId, endpoint)` also keeps the legitimate case
     * working: browsers rotate the key pair for an unchanged endpoint, and the
     * upsert updates in place.
     */
    static async subscribe(userId: number, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string) {
        if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
            throw badRequest("Invalid push subscription");
        }
        if (subscription.endpoint.length > 500) {
            throw badRequest("Push endpoint is too long");
        }

        return await prisma.pushSubscription.upsert({
            where: { userId_endpoint: { userId, endpoint: subscription.endpoint } },
            update: {
                p256dh: subscription.keys.p256dh,
                auth: subscription.keys.auth,
                userAgent: userAgent || null,
            },
            create: {
                userId,
                endpoint: subscription.endpoint,
                p256dh: subscription.keys.p256dh,
                auth: subscription.keys.auth,
                userAgent: userAgent || null,
            },
        });
    }

    static async unsubscribe(userId: number, endpoint: string) {
        await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
        return { success: true };
    }

    // Fire-and-forget push to all of the user's devices; silently no-ops when unconfigured
    static async send(userId: number, title: string, body: string, url?: string) {
        if (!IS_CONFIGURED) return;
        try {
            const subs = await prisma.pushSubscription.findMany({ where: { userId } });
            for (const sub of subs) {
                try {
                    await webpush.sendNotification(
                        {
                            endpoint: sub.endpoint,
                            keys: { p256dh: sub.p256dh, auth: sub.auth },
                        },
                        JSON.stringify({ title, body, url: url || "/dashboard" })
                    );
                } catch (err: any) {
                    // 404/410 → the subscription is dead, drop it
                    if (err?.statusCode === 404 || err?.statusCode === 410) {
                        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
                    } else {
                        logger.warn({ err: err.message }, "Push notification failed");
                    }
                }
            }
        } catch (err: any) {
            logger.warn({ err: err.message }, "Push send failed");
        }
    }
}
