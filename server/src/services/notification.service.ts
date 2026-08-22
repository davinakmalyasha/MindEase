import { prisma } from "../lib/prisma";
import { notifyUser } from "./realtime.service";
import { MailerService } from "./mailer.service";
import { PushService } from "./push.service";



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

            if (!prefs[type].inApp) return null;

            if (wantsEmail && prefs[type].email && user?.email) {
                const { subject, html } = MailerService.buildNotificationEmail({
                    title: data.title,
                    message: data.message,
                    type,
                });
                MailerService.send(user.email, subject, html).catch(() => {});
            }
        }

        const notification = await prisma.notification.create({
            data: {
                userId: data.userId,
                title: data.title,
                message: data.message,
                type,
            },
        });

        // Live push via the Go realtime service (fire-and-forget)
        await notifyUser(data.userId, data.title, data.message, type);

        // Web push (when the user has subscribed a device)
        await PushService.send(data.userId, data.title, data.message, "/dashboard");

        return notification;
    }

    // Admin broadcast: one batched insert, then realtime + web push per user.
    // Emails are intentionally NOT sent (a broadcast must never mass-email).
    static async broadcast(title: string, message: string, type = "system") {
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

        await Promise.allSettled(
            recipients.flatMap((u) => [
                notifyUser(u.id, title, message, type),
                PushService.send(u.id, title, message, "/dashboard"),
            ])
        );

        return { recipients: recipients.length };
    }

    static async getPreferences(userId: number) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { notificationPrefs: true },
        });
        return parsePrefs(user?.notificationPrefs ?? null);
    }

    static async updatePreferences(userId: number, prefs: Partial<NotificationPrefs>) {
        const clean = { ...JSON.parse(JSON.stringify(DEFAULT_PREFS)), ...prefs };
        await prisma.user.update({
            where: { id: userId },
            data: { notificationPrefs: JSON.stringify(clean) },
        });
        return clean;
    }

    static async getUserNotifications(userId: number, page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const take = Math.min(limit, 30);
        const [rows, total] = await Promise.all([
            prisma.notification.findMany({
                where: { userId },
                orderBy: { createdAt: "desc" },
                skip,
                take,
            }),
            prisma.notification.count({ where: { userId } }),
        ]);
        return { rows, total, page, totalPages: Math.ceil(total / take) };
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
