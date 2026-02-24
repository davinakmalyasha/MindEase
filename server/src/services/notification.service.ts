import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface CreateNotificationInput {
    userId: number;
    title: string;
    message: string;
    type?: string;
}

export class NotificationService {
    static async create(data: CreateNotificationInput) {
        return await prisma.notification.create({
            data: {
                userId: data.userId,
                title: data.title,
                message: data.message,
                type: data.type || "system",
            },
        });
    }

    static async getUserNotifications(userId: number, limit = 20) {
        return await prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: limit,
        });
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
