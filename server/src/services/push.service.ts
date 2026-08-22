import webpush from "web-push";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";

const IS_CONFIGURED = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

if (IS_CONFIGURED) {
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || "mailto:no-reply@mindease.app",
        process.env.VAPID_PUBLIC_KEY!,
        process.env.VAPID_PRIVATE_KEY!
    );
}

export class PushService {
    static async subscribe(userId: number, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string) {
        if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
            throw new Error("Invalid push subscription");
        }
        return await prisma.pushSubscription.upsert({
            where: { endpoint: subscription.endpoint },
            update: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, userAgent: userAgent || null },
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
