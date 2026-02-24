import { Request, Response } from "express";
import { AIService } from "../services/ai.service";
import { WellnessService } from "../services/wellness.service";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class AIController {
    static async getPreSessionQuestions(req: Request, res: Response) {
        try {
            const { specialty, notes } = req.body;
            if (!specialty) {
                res.status(400).json({ status: "error", message: "Specialty is required." });
                return;
            }

            const questions = await AIService.generatePreSessionQuestions(specialty, notes);
            res.json({ status: "success", data: questions });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to generate questions.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async getDoctorBriefing(req: Request, res: Response) {
        try {
            const user = (req as any).user;
            const { appointmentId, preSessionAnswers } = req.body;

            const appointment = await prisma.appointment.findUnique({
                where: { id: parseInt(appointmentId) },
                include: {
                    user: { select: { name: true, id: true } },
                    doctor: { select: { specialty: true } },
                },
            });

            if (!appointment) {
                res.status(404).json({ status: "error", message: "Appointment not found." });
                return;
            }

            // Fetch patient mood history
            const moodHistory = await WellnessService.getMoodHistory(appointment.userId, 14);

            const briefing = await AIService.generateDoctorBriefing(
                appointment.user.name || "Patient",
                appointment.doctor.specialty,
                moodHistory,
                preSessionAnswers || []
            );

            res.json({ status: "success", data: { briefing } });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to generate briefing.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async getWellnessSuggestions(req: Request, res: Response) {
        try {
            const userId = (req as any).user.id;
            const recentMoods = await WellnessService.getMoodHistory(userId, 14);

            const suggestions = await AIService.suggestResources(recentMoods);
            res.json({ status: "success", data: suggestions });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to get suggestions.";
            res.status(500).json({ status: "error", message });
        }
    }
}
