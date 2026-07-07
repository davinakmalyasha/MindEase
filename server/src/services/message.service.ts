import { PrismaClient } from "@prisma/client";
import { sanitize } from "../utils/sanitize";
import { publishEvent } from "./realtime.service";

const prisma = new PrismaClient();

export class MessageService {
    // Participants must share a confirmed or completed appointment
    static async canChat(actorId: number, otherUserId: number) {
        const appointment = await prisma.appointment.findFirst({
            where: {
                status: { in: ["confirmed", "completed"] },
                OR: [
                    { userId: actorId, doctor: { userId: otherUserId } },
                    { userId: otherUserId, doctor: { userId: actorId } },
                ],
            },
        });
        return !!appointment;
    }

    static async getConversations(userId: number) {
        const messages = await prisma.message.findMany({
            where: {
                OR: [{ senderId: userId }, { receiverId: userId }],
            },
            include: {
                sender: { select: { id: true, name: true, avatar: true, role: true } },
                receiver: { select: { id: true, name: true, avatar: true, role: true } },
            },
            orderBy: { createdAt: "desc" },
            take: 500,
        });

        const map = new Map<number, any>();
        for (const msg of messages) {
            const otherId = msg.senderId === userId ? msg.receiverId : msg.senderId;
            const other = msg.senderId === userId ? msg.receiver : msg.sender;
            if (!map.has(otherId)) {
                map.set(otherId, {
                    user: other,
                    lastMessage: msg.content,
                    lastMessageAt: msg.createdAt,
                    lastMessageFromMe: msg.senderId === userId,
                    unreadCount: msg.senderId !== userId && !msg.isRead ? 1 : 0,
                });
            } else if (msg.senderId !== userId && !msg.isRead) {
                map.get(otherId).unreadCount += 1;
            }
        }

        return Array.from(map.values()).sort(
            (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
        );
    }

    static async getMessages(userId: number, otherUserId: number, limit = 50, before?: number) {
        const chatAllowed = await this.canChat(userId, otherUserId);
        if (!chatAllowed) {
            throw new Error("You can only chat with users you share a confirmed or completed appointment with");
        }

        const messages = await prisma.message.findMany({
            where: {
                OR: [
                    { senderId: userId, receiverId: otherUserId },
                    { senderId: otherUserId, receiverId: userId },
                ],
                ...(before ? { id: { lt: before } } : {}),
            },
            orderBy: { id: "desc" },
            take: Math.min(limit, 100),
        });

        // Mark incoming messages as read when fetched
        await prisma.message.updateMany({
            where: { senderId: otherUserId, receiverId: userId, isRead: false },
            data: { isRead: true },
        });

        return messages.reverse();
    }

    static async sendMessage(senderId: number, receiverId: number, content: string) {
        if (senderId === receiverId) throw new Error("Cannot message yourself");

        const receiver = await prisma.user.findUnique({ where: { id: receiverId } });
        if (!receiver) throw new Error("User not found");

        const chatAllowed = await this.canChat(senderId, receiverId);
        if (!chatAllowed) {
            throw new Error("You can only chat with users you share a confirmed or completed appointment with");
        }

        const message = await prisma.message.create({
            data: { senderId, receiverId, content: sanitize(content) },
            include: {
                sender: { select: { id: true, name: true, avatar: true } },
            },
        });

        await prisma.notification.create({
            data: {
                userId: receiverId,
                title: "New message",
                message: `You have a new message from ${message.sender.name}.`,
                type: "message",
            },
        });

        // Live push to both parties via the Go realtime service
        await publishEvent(receiverId, {
            type: "message:new",
            payload: { message: { id: message.id, content: message.content, senderId, receiverId, createdAt: message.createdAt } },
        });
        await publishEvent(senderId, { type: "message:sent", payload: { messageId: message.id } });

        return message;
    }
}
