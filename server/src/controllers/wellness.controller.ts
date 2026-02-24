import { Request, Response } from "express";
import { WellnessService } from "../services/wellness.service";

export class WellnessController {
    static async logMood(req: Request, res: Response) {
        try {
            const userId = (req as any).user.id;
            const { mood, notes } = req.body;

            if (!mood || mood < 1 || mood > 5) {
                res.status(400).json({ status: "error", message: "Mood must be 1-5." });
                return;
            }

            const entry = await WellnessService.logMood(userId, mood, notes);
            res.status(201).json({ status: "success", data: entry });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to log mood.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async getMoodHistory(req: Request, res: Response) {
        try {
            const userId = (req as any).user.id;
            const days = parseInt(req.query.days as string) || 14;
            const entries = await WellnessService.getMoodHistory(userId, days);
            res.json({ status: "success", data: entries });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to get mood history.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async getMoodStats(req: Request, res: Response) {
        try {
            const userId = (req as any).user.id;
            const stats = await WellnessService.getMoodStats(userId);
            res.json({ status: "success", data: stats });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to get mood stats.";
            res.status(500).json({ status: "error", message });
        }
    }
}
