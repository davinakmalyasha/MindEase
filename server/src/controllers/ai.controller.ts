import { Request, Response } from "express";
import { PreSessionService } from "../services/preSession.service";
import { AIService } from "../services/ai.service";
import { WellnessService } from "../services/wellness.service";
import { prisma } from "../lib/prisma";
import { publicMessageFor } from "../utils/appError";

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

/**
 * Why this doctor was returned — derived only from properties that were
 * actually used to select them, so every reason is verifiable against the row.
 * Returns an empty list rather than inventing one; the client renders nothing
 * rather than a fabricated explanation.
 */
const buildMatchReasons = (
    doctor: { specialty: string; experience: number; price: number; rating: number; _count: { reviews: number } },
    criteriaSpecialty?: string
): string[] => {
    const reasons: string[] = [];
    if (criteriaSpecialty && doctor.specialty.toLowerCase().includes(criteriaSpecialty.toLowerCase())) {
        reasons.push(`Specialises in ${doctor.specialty}`);
    }
    if (doctor._count.reviews > 0) {
        reasons.push(`${doctor.rating.toFixed(1)} from ${doctor._count.reviews} review${doctor._count.reviews === 1 ? "" : "s"}`);
    }
    if (doctor.experience > 0) {
        reasons.push(`${doctor.experience} year${doctor.experience === 1 ? "" : "s"} of experience`);
    }
    return reasons;
};

export class AIController {
    static async getPreSessionQuestions(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { appointmentId } = req.body;
            const result = await PreSessionService.getQuestionsForPatient(Number(appointmentId), userId);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to generate questions.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async getPreSessionData(req: Request, res: Response) {
        try {
            const appointmentId = parseInt(req.params.appointmentId as string);
            const data = await PreSessionService.getData(appointmentId, req.user!);
            res.json({ status: "success", data });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to fetch pre-session data.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async submitAnswers(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { appointmentId, answers } = req.body;
            const result = await PreSessionService.submitAnswers(Number(appointmentId), userId, answers);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to submit answers.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async getWellnessSuggestions(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const recentMoods = await WellnessService.getMoodHistory(userId, 14);
            const result = await AIService.suggestResources(recentMoods);
            res.json({
                status: "success",
                data: result.data,
                /**
                 * Whether these activities were written by the model or chosen
                 * from a fixed local list. The UI shows a "standard guidance"
                 * state for the latter, so nobody mistakes a template for a
                 * personal suggestion.
                 */
                ai: { source: result.source, degradedReason: result.degradedReason },
            });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to get suggestions.", status: 500 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async matchDoctors(req: Request, res: Response) {
        try {
            const query = String(req.body.query || "").trim();
            if (query.length < 3) {
                return res.status(400).json({ status: "error", message: "Describe what you're looking for (min. 3 characters)" });
            }

            const ai = await AIService.matchDoctors(query);
            let criteria = ai.data ?? { keywords: [] as string[] };
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
                    /**
                     * Stated as the property that actually drove the match.
                     *
                     * This used to be the *query's own keywords*, attached
                     * identically to every returned doctor and rendered in the
                     * UI as "Why: anxious, stress relief, panic" — a fabricated
                     * rationale for a recommendation. On a mental-health
                     * platform, steering someone towards a "trauma therapist" on
                     * a keyword match with an invented justification is exactly
                     * the kind of claim that should not ship.
                     */
                    matchReasons: buildMatchReasons(d, criteria.specialty),
                }));

            res.json({
                status: "success",
                data: {
                    query,
                    criteria: { specialty: criteria.specialty ?? null, maxPrice: criteria.maxPrice ?? null, minExperience: criteria.minExperience ?? null },
                    doctors: matched,
                    /**
                     * Replaces `aiPowered: !!process.env.GEMINI_API_KEY`, which
                     * reported whether a *key* was configured rather than
                     * whether a model was actually consulted — it claimed "AI
                     * powered" for a plain keyword match whenever the key was
                     * merely present, and claimed it for real model output only
                     * by accident.
                     */
                    ai: { source: ai.source, degradedReason: ai.degradedReason },
                },
            });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to match doctors.", status: 500 };
            res.status(status).json({ status: "error", message });
        }
    }
}
