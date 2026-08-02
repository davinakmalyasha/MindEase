import { Request, Response } from "express";
import { MessageService } from "../services/message.service";

export class MessageController {
    static async getConversations(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const conversations = await MessageService.getConversations(userId);
            res.json({ status: "success", data: conversations });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to fetch conversations.";
            res.status(500).json({ status: "error", message });
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
            const message = error instanceof Error ? error.message : "Failed to fetch messages.";
            res.status(403).json({ status: "error", message });
        }
    }

    static async sendMessage(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const receiverId = parseInt(req.params.userId as string);
            const { content } = req.body;

            const message = await MessageService.sendMessage(userId, receiverId, content);
            res.status(201).json({ status: "success", data: message });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to send message.";
            res.status(400).json({ status: "error", message });
        }
    }
}
