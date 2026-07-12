import { Request, Response } from "express";
import { PreSessionService } from "../services/preSession.service";
import { AIService } from "../services/ai.service";
import { WellnessService } from "../services/wellness.service";

export class AIController {
    static async getPreSessionQuestions(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { appointmentId } = req.body;
            const result = await PreSessionService.getQuestionsForPatient(Number(appointmentId), userId);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to generate questions.";
            res.status(400).json({ status: "error", message });
        }
    }

    static async getPreSessionData(req: Request, res: Response) {
        try {
            const appointmentId = parseInt(req.params.appointmentId as string);
            const data = await PreSessionService.getData(appointmentId, req.user!);
            res.json({ status: "success", data });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to fetch pre-session data.";
            res.status(400).json({ status: "error", message });
        }
    }

    static async submitAnswers(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { appointmentId, answers } = req.body;
            const result = await PreSessionService.submitAnswers(Number(appointmentId), userId, answers);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to submit answers.";
            res.status(400).json({ status: "error", message });
        }
    }

    static async getWellnessSuggestions(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const recentMoods = await WellnessService.getMoodHistory(userId, 14);
            const suggestions = await AIService.suggestResources(recentMoods);
            res.json({ status: "success", data: suggestions });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to get suggestions.";
            res.status(500).json({ status: "error", message });
        }
    }
}
