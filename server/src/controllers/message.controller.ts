import { Request, Response } from "express";
import { MessageService } from "../services/message.service";
import { saveFile } from "../lib/storage";
import { publicMessageFor } from "../utils/appError";

export class MessageController {
    static async getConversations(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const conversations = await MessageService.getConversations(userId);
            res.json({ status: "success", data: conversations });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to fetch conversations.", status: 500 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async getMessages(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const otherUserId = parseInt(req.params.userId as string);
            const limit = parseInt(req.query.limit as string) || 50;
            const before = req.query.before ? parseInt(req.query.before as string) : undefined;

            const messages = await MessageService.getMessages(userId, otherUserId, limit, before);
            res.json({ status: "success", data: messages });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to fetch messages.", status: 403 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async sendMessage(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const receiverId = parseInt(req.params.userId as string);
            const { content, attachment } = req.body;

            const message = await MessageService.sendMessage(userId, receiverId, content, attachment);
            res.status(201).json({ status: "success", data: message });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to send message.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async uploadAttachment(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const receiverId = parseInt(req.body?.receiverId as string);
            if (!receiverId) {
                res.status(400).json({ status: "error", message: "receiverId is required" });
                return;
            }
            // Uploads are only meaningful for an active conversation — gate
            // them like sends so any account can't use us as free storage.
            const chatAllowed = await MessageService.canChat(userId, receiverId);
            if (!chatAllowed) {
                res.status(403).json({
                    status: "error",
                    message: "You can only upload attachments for users you share a confirmed or completed appointment with",
                });
                return;
            }
            if (!req.file) {
                res.status(400).json({ status: "error", message: "No file provided" });
                return;
            }
            const url = await saveFile(req.file.buffer, req.file.originalname, req.file.mimetype);
            const type = req.file.mimetype.startsWith("image/") ? "image" : "file";
            res.status(201).json({ status: "success", data: { url, type } });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to upload attachment.", status: 500 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async typingIndicator(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const receiverId = parseInt(req.params.userId as string);
            const isTyping = req.body?.isTyping === true;

            const result = await MessageService.sendTypingEvent(userId, receiverId, isTyping);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to send typing indicator.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async deleteMessage(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const messageId = parseInt(req.params.id as string);
            const result = await MessageService.deleteMessage(messageId, userId);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to delete message.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async setReaction(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const messageId = parseInt(req.params.id as string);
            const { reaction } = req.body;
            const updated = await MessageService.setReaction(messageId, userId, reaction);
            res.json({ status: "success", data: updated });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to update reaction.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }
}
