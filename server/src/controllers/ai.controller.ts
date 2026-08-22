import { Request, Response } from "express";
import { PreSessionService } from "../services/preSession.service";
import { AIService } from "../services/ai.service";
import { WellnessService } from "../services/wellness.service";
import { prisma } from "../lib/prisma";

// Fallback keyword → specialty hints when Gemini is unavailable
const SPECIALTY_HINTS: { keywords: RegExp; specialty: string }[] = [
    { keywords: /(anxiet|cemas|panic|kecemasan)/i, specialty: "Clinical" },
    { keywords: /(depress|depresi|hopeless)/i, specialty: "Clinical" },
    { keywords: /(trauma|ptsd|abuse|kekerasan)/i, specialty: "Trauma" },
    { keywords: /(addict|kecanduan|narkoba|alcohol|alkohol)/i, specialty: "Addiction" },
    { keywords: /(marri|pasangan|relationship|rumah tangga)/i, specialty: "Family" },
    { keywords: /(child|anak|teen|remaja)/i, specialty: "Family" },
    { keywords: /(career|karier|work|kerja|burnout)/i, specialty: "Clinical" },
];

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

    static async matchDoctors(req: Request, res: Response) {
        try {
            const query = String(req.body.query || "").trim();
            if (query.length < 3) {
                return res.status(400).json({ status: "error", message: "Describe what you're looking for (min. 3 characters)" });
            }

            let criteria = (await AIService.matchDoctors(query)) ?? { keywords: [] as string[] };
            if (!criteria?.specialty) {
                // Fallback: keyword hints
                const hint = SPECIALTY_HINTS.find((h) => h.keywords.test(query));
                criteria = { ...criteria, specialty: hint?.specialty };
            }
            if (!criteria.keywords || criteria.keywords.length === 0) {
                criteria = { ...criteria, keywords: query.split(/\s+/).filter((w) => w.length > 3).slice(0, 6) };
            }

            // Query the directory with the structured criteria
            const doctors = await prisma.doctor.findMany({
                where: {
                    verificationStatus: "approved",
                    ...(criteria.specialty ? { specialty: { contains: criteria.specialty } } : {}),
                    ...(criteria.minExperience ? { experience: { gte: criteria.minExperience } } : {}),
                    ...(criteria.maxPrice ? { price: { lte: criteria.maxPrice } } : {}),
                },
                include: {
                    user: { select: { name: true, avatar: true } },
                    _count: { select: { reviews: true } },
                },
                orderBy: { rating: "desc" },
                take: 5,
            });

            // Rank: prefer specialty match first, then rating
            const matched = doctors
                .filter((d) => {
                    if (!criteria.specialty) return true;
                    return d.specialty.toLowerCase().includes(criteria.specialty!.toLowerCase());
                })
                .map((d) => ({
                    id: d.id,
                    name: d.user.name || "Doctor",
                    avatar: d.user.avatar,
                    specialty: d.specialty,
                    rating: d.rating,
                    price: d.price,
                    experience: d.experience,
                    reviewCount: d._count.reviews,
                    matchReasons: (criteria.keywords || []).slice(0, 3),
                }));

            res.json({
                status: "success",
                data: {
                    query,
                    criteria: { specialty: criteria.specialty ?? null, maxPrice: criteria.maxPrice ?? null, minExperience: criteria.minExperience ?? null },
                    doctors: matched,
                    aiPowered: !!process.env.GEMINI_API_KEY,
                },
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to match doctors.";
            res.status(500).json({ status: "error", message });
        }
    }
}
