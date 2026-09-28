import { Request, Response } from "express";
import { WellnessService } from "../services/wellness.service";
import { publicMessageFor } from "../utils/appError";

export class WellnessController {
    static async logMood(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const mood = Number(req.body.mood);
            const notes = req.body.notes;
            const factors = req.body.factors;

            const entry = await WellnessService.logMood(userId, mood, notes, factors);
            res.status(201).json({ status: "success", data: entry });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to log mood.";
            res.status(400).json({ status: "error", message });
        }
    }

    static async getMoodHistory(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            // Bounded by MoodHistorySchema; the default only applies when the
            // parameter is absent.
            const days = typeof req.query.days === "number" ? req.query.days : 14;
            const entries = await WellnessService.getMoodHistory(userId, days);
            res.json({ status: "success", data: entries });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to get mood history.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async getMoodStats(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const days = typeof req.query.days === "number" ? req.query.days : 30;
            const stats = await WellnessService.getMoodStats(userId, days);
            res.json({ status: "success", data: stats });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to get mood stats.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async createJournalEntry(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { content } = req.body;
            const entry = await WellnessService.createJournalEntry(userId, content);
            res.status(201).json({ status: "success", data: entry });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to save journal entry.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async updateJournalEntry(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const entryId = parseInt(req.params.id as string);
            if (!entryId) return res.status(400).json({ status: "error", message: "Invalid entry id" });
            const { content } = req.body;
            const entry = await WellnessService.updateJournalEntry(userId, entryId, content);
            res.json({ status: "success", data: entry });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to update journal entry.";
            const status = message.includes("not found") ? 404 : 400;
            res.status(status).json({ status: "error", message });
        }
    }

    static async deleteJournalEntry(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const entryId = parseInt(req.params.id as string);
            if (!entryId) return res.status(400).json({ status: "error", message: "Invalid entry id" });
            const result = await WellnessService.deleteJournalEntry(userId, entryId);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to delete journal entry.";
            const status = message.includes("not found") ? 404 : 400;
            res.status(status).json({ status: "error", message });
        }
    }

    static async getJournalEntries(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const limit = typeof req.query.limit === "number" ? req.query.limit : 20;
            const entries = await WellnessService.getJournalEntries(userId, limit);
            res.json({ status: "success", data: entries });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to fetch journal entries.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async summarizeJournal(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const result = await WellnessService.summarizeJournal(userId);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to summarize journal.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async submitAssessment(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { type, answers } = req.body;
            const { assessment, risk } = await WellnessService.submitAssessment(userId, type, answers);
            // The risk signal travels with the result so the client can show
            // crisis resources before the user navigates away.
            res.status(201).json({ status: "success", data: { ...assessment, risk } });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to submit assessment.";
            res.status(400).json({ status: "error", message });
        }
    }

    static async getAssessments(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const type = req.query.type as string | undefined;
            const limit = parseInt(req.query.limit as string) || 10;
            const assessments = await WellnessService.getAssessments(userId, type, limit);
            res.json({ status: "success", data: assessments });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to fetch assessments.";
            res.status(500).json({ status: "error", message });
        }
    }
}
