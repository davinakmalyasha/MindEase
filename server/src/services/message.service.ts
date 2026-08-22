import { prisma } from "../lib/prisma";
import { sanitize } from "../utils/sanitize";
import { publishEvent } from "./realtime.service";
import { NotificationService } from "./notification.service";



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
                    lastMessage: msg.deletedAt
                        ? "Message deleted"
                        : msg.attachmentUrl
                          ? (msg.content || "📎 Attachment")
                          : msg.content,
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

        // Soft-deleted messages must not leak their content over REST —
        // keep only metadata (id/deletedAt) so clients render a tombstone.
        const visible = messages.map((m) =>
            m.deletedAt
                ? { ...m, content: null, attachmentUrl: null, attachmentType: null }
                : m
        );

        // Mark incoming messages as read when fetched (read receipts)
        const readResult = await prisma.message.updateMany({
            where: { senderId: otherUserId, receiverId: userId, isRead: false },
            data: { isRead: true, readAt: new Date() },
        });

        // Push a live read receipt so the sender's UI updates instantly
        if (readResult.count > 0 && messages.length > 0) {
            await publishEvent(otherUserId, {
                type: "message:read",
                payload: { byUserId: userId, upToId: messages[0].id },
            });
        }

        return visible.reverse();
    }

    static async sendMessage(
        senderId: number,
        receiverId: number,
        content: string,
        attachment?: { url: string; type: string }
    ) {
        if (senderId === receiverId) throw new Error("Cannot message yourself");

        const receiver = await prisma.user.findUnique({ where: { id: receiverId } });
        if (!receiver) throw new Error("User not found");

        const chatAllowed = await this.canChat(senderId, receiverId);
        if (!chatAllowed) {
            throw new Error("You can only chat with users you share a confirmed or completed appointment with");
        }

        const message = await prisma.message.create({
            data: {
                senderId,
                receiverId,
                content: sanitize(content),
                ...(attachment ? { attachmentUrl: attachment.url, attachmentType: attachment.type } : {}),
            },
            include: {
                sender: { select: { id: true, name: true, avatar: true } },
            },
        });

        // In-app notification + optional email copy per the receiver's per-channel preferences
        const receiverPrefs = await NotificationService.getPreferences(receiverId);
        await NotificationService.create({
            userId: receiverId,
            title: "New message",
            message: attachment
                ? `${message.sender.name} sent you an attachment.`
                : `You have a new message from ${message.sender.name}.`,
            type: "message",
            email: receiverPrefs.message?.email === true,
        });

        // Live push to both parties via the Go realtime service
        await publishEvent(receiverId, {
            type: "message:new",
            payload: {
                message: {
                    id: message.id,
                    content: message.content,
                    attachmentUrl: message.attachmentUrl,
                    attachmentType: message.attachmentType,
                    senderId,
                    receiverId,
                    createdAt: message.createdAt,
                },
            },
        });

        return message;
    }

    // Typing indicator: transient event (not persisted), pushed via realtime
    static async sendTypingEvent(senderId: number, receiverId: number, isTyping: boolean) {
        if (senderId === receiverId) throw new Error("Cannot message yourself");
        const chatAllowed = await this.canChat(senderId, receiverId);
        if (!chatAllowed) {
            throw new Error("You can only chat with users you share a confirmed or completed appointment with");
        }

        await publishEvent(receiverId, {
            type: isTyping ? "typing:start" : "typing:stop",
            payload: { userId: senderId },
        });
        return { success: true };
    }

    // Soft-delete: only the sender may delete; renders as "Message deleted"
    static async deleteMessage(messageId: number, actorId: number) {
        const message = await prisma.message.findUnique({ where: { id: messageId } });
        if (!message) throw new Error("Message not found");
        if (message.senderId !== actorId) throw new Error("Forbidden: you can only delete your own messages");

        await prisma.message.update({
            where: { id: messageId },
            data: { deletedAt: new Date() },
        });

        await publishEvent(message.receiverId, {
            type: "message:deleted",
            payload: { messageId, byUserId: actorId },
        });
        return { success: true };
    }

    // Reactions: single emoji per message, set by either participant
    static async setReaction(messageId: number, actorId: number, reaction: string | null) {
        const message = await prisma.message.findUnique({ where: { id: messageId } });
        if (!message || message.deletedAt) throw new Error("Message not found");
        if (message.senderId !== actorId && message.receiverId !== actorId) {
            throw new Error("Forbidden: not a participant of this conversation");
        }

        const updated = await prisma.message.update({
            where: { id: messageId },
            data: { reaction: reaction || null },
        });

        const otherId = message.senderId === actorId ? message.receiverId : message.senderId;
        await publishEvent(otherId, {
            type: "message:reacted",
            payload: { messageId, reaction: updated.reaction, byUserId: actorId },
        });
        return updated;
    }
}
