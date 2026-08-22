import { prisma } from "../lib/prisma";
import { AIService } from "./ai.service";

export const MOOD_FACTORS = ["sleep", "exercise", "social", "work", "stress"] as const;
export type MoodFactor = (typeof MOOD_FACTORS)[number];

export const ASSESSMENT_TYPES = ["phq9", "gad7"] as const;
export type AssessmentType = (typeof ASSESSMENT_TYPES)[number];

export const ASSESSMENT_QUESTION_COUNTS: Record<AssessmentType, number> = {
    phq9: 9,
    gad7: 7,
};

const severityFor = (type: AssessmentType, score: number): string => {
    if (type === "phq9") {
        if (score <= 4) return "minimal";
        if (score <= 9) return "mild";
        if (score <= 14) return "moderate";
        if (score <= 19) return "moderately-severe";
        return "severe";
    }
    if (score <= 4) return "minimal";
    if (score <= 9) return "mild";
    if (score <= 14) return "moderate";
    return "severe";
};

const parseFactors = (raw: string | null): MoodFactor[] => {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((f) => MOOD_FACTORS.includes(f)) : [];
    } catch {
        return [];
    }
};

export class WellnessService {
    static async logMood(userId: number, mood: number, notes?: string, factors?: string[]) {
        if (mood < 1 || mood > 5) throw new Error("Mood must be between 1 and 5.");

        const validFactors = (factors || []).filter((f) => (MOOD_FACTORS as readonly string[]).includes(f));
        const data = {
            mood,
            notes,
            factors: validFactors.length ? JSON.stringify(validFactors) : null,
        };

        // One entry per calendar day: re-logging updates today's entry instead
        // of stacking duplicates (keeps streaks and averages meaningful).
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const existing = await prisma.moodEntry.findFirst({
            where: { userId, createdAt: { gte: dayStart, lt: dayEnd } },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });
        if (existing) {
            return await prisma.moodEntry.update({ where: { id: existing.id }, data });
        }

        return await prisma.moodEntry.create({ data: { userId, ...data } });
    }

    static async getMoodHistory(userId: number, days = 14) {
        const since = new Date();
        since.setDate(since.getDate() - days);

        const entries = await prisma.moodEntry.findMany({
            where: {
                userId,
                createdAt: { gte: since },
            },
            orderBy: { createdAt: "desc" },
        });

        return entries.map((e) => ({ ...e, factors: parseFactors(e.factors) }));
    }

    static async getMoodStats(userId: number) {
        const entries = await prisma.moodEntry.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: 30,
        });

        if (entries.length === 0) {
            return { average: 0, total: 0, streak: 0, trend: "neutral" as const, factorCorrelation: {} };
        }

        const average = entries.reduce((sum, e) => sum + e.mood, 0) / entries.length;

        // Calculate streak (consecutive days with entries) — timezone-safe local dates
        let streak = 0;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const localDateKey = (d: Date) =>
            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

        const entryDates = new Set(entries.map((e) => localDateKey(new Date(e.createdAt))));

        for (let i = 0; i < 30; i++) {
            const checkDate = new Date(today);
            checkDate.setDate(today.getDate() - i);
            if (entryDates.has(localDateKey(checkDate))) {
                streak++;
            } else {
                break;
            }
        }

        // Trend: compare first half vs second half
        const mid = Math.floor(entries.length / 2);
        const recentAvg = entries.slice(0, mid).reduce((s, e) => s + e.mood, 0) / (mid || 1);
        const olderAvg = entries.slice(mid).reduce((s, e) => s + e.mood, 0) / ((entries.length - mid) || 1);
        const trend = recentAvg > olderAvg + 0.3 ? "improving" : recentAvg < olderAvg - 0.3 ? "declining" : "stable";

        // Factor correlation: average mood per factor tag
        const factorCorrelation: Record<string, number> = {};
        for (const factor of MOOD_FACTORS) {
            const tagged = entries.filter((e) => parseFactors(e.factors).includes(factor));
            if (tagged.length > 0) {
                factorCorrelation[factor] =
                    Math.round((tagged.reduce((s, e) => s + e.mood, 0) / tagged.length) * 10) / 10;
            }
        }

        return {
            average: Math.round(average * 10) / 10,
            total: entries.length,
            streak,
            trend: trend as "improving" | "declining" | "stable",
            factorCorrelation,
        };
    }

    static async createJournalEntry(userId: number, content: string) {
        return await prisma.journalEntry.create({
            data: { userId, content },
        });
    }

    // Owner-checked edit/delete for journal entries
    static async updateJournalEntry(userId: number, entryId: number, content: string) {
        const entry = await prisma.journalEntry.findUnique({ where: { id: entryId } });
        if (!entry || entry.userId !== userId) throw new Error("Journal entry not found");
        return await prisma.journalEntry.update({
            where: { id: entryId },
            data: { content },
        });
    }

    static async deleteJournalEntry(userId: number, entryId: number) {
        const entry = await prisma.journalEntry.findUnique({ where: { id: entryId } });
        if (!entry || entry.userId !== userId) throw new Error("Journal entry not found");
        await prisma.journalEntry.delete({ where: { id: entryId } });
        return { success: true };
    }

    static async getJournalEntries(userId: number, limit = 20) {
        return await prisma.journalEntry.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: Math.min(limit, 100),
        });
    }

    static async summarizeJournal(userId: number) {
        const entries = await prisma.journalEntry.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: 7,
        });
        if (entries.length === 0) return { summary: null, count: 0 };

        const summary = await AIService.summarizeJournal(
            entries.map((e) => e.content),
            new Date(entries[entries.length - 1].createdAt),
            new Date(entries[0].createdAt)
        );

        return { summary, count: entries.length };
    }

    static async submitAssessment(userId: number, type: string, answers: number[]) {
        if (!(ASSESSMENT_TYPES as readonly string[]).includes(type)) {
            throw new Error("Assessment type must be phq9 or gad7");
        }
        const questionCount = ASSESSMENT_QUESTION_COUNTS[type as AssessmentType];
        if (!Array.isArray(answers) || answers.length !== questionCount) {
            throw new Error(`Assessment requires exactly ${questionCount} answers`);
        }
        if (!answers.every((a) => Number.isInteger(a) && a >= 0 && a <= 3)) {
            throw new Error("Each answer must be an integer between 0 and 3");
        }

        const score = answers.reduce((s, a) => s + a, 0);
        const severity = severityFor(type as AssessmentType, score);

        return await prisma.assessment.create({
            data: {
                userId,
                type,
                answersJson: JSON.stringify(answers),
                score,
                severity,
            },
        });
    }

    static async getAssessments(userId: number, type?: string, limit = 10) {
        return await prisma.assessment.findMany({
            where: {
                userId,
                ...(type && (ASSESSMENT_TYPES as readonly string[]).includes(type) ? { type } : {}),
            },
            orderBy: { createdAt: "desc" },
            take: Math.min(limit, 100),
        });
    }

    static async getLatestAssessments(userId: number) {
        const [phq9, gad7] = await Promise.all([
            prisma.assessment.findFirst({ where: { userId, type: "phq9" }, orderBy: { createdAt: "desc" } }),
            prisma.assessment.findFirst({ where: { userId, type: "gad7" }, orderBy: { createdAt: "desc" } }),
        ]);
        return [phq9, gad7].filter(Boolean).map((a) => ({
            type: a!.type,
            score: a!.score,
            severity: a!.severity,
            createdAt: a!.createdAt,
        }));
    }
}
