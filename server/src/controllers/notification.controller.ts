import { Request, Response } from "express";
import { NotificationService } from "../services/notification.service";

export class NotificationController {
    static async getNotifications(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const page = parseInt(req.query.page as string) || 1;
            const limit = Math.min(parseInt(req.query.limit as string) || 20, 30);
            const notifications = await NotificationService.getUserNotifications(userId, page, limit);
            res.json({ status: "success", data: notifications });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to fetch notifications.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async markAsRead(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const notificationId = parseInt(req.params.id as string);
            await NotificationService.markAsRead(notificationId, userId);
            res.json({ status: "success" });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to mark as read.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async markAllAsRead(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            await NotificationService.markAllAsRead(userId);
            res.json({ status: "success" });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to mark all as read.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async getUnreadCount(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const count = await NotificationService.getUnreadCount(userId);
            res.json({ status: "success", data: { count } });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to get unread count.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async getPreferences(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const prefs = await NotificationService.getPreferences(userId);
            res.json({ status: "success", data: prefs });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to get preferences.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async updatePreferences(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const prefs = await NotificationService.updatePreferences(userId, req.body);
            res.json({ status: "success", data: prefs });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to update preferences.";
            res.status(500).json({ status: "error", message });
        }
    }
}
