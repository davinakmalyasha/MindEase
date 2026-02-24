import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class WellnessService {
    static async logMood(userId: number, mood: number, notes?: string) {
        if (mood < 1 || mood > 5) throw new Error("Mood must be between 1 and 5.");

        return await prisma.moodEntry.create({
            data: { userId, mood, notes },
        });
    }

    static async getMoodHistory(userId: number, days = 14) {
        const since = new Date();
        since.setDate(since.getDate() - days);

        return await prisma.moodEntry.findMany({
            where: {
                userId,
                createdAt: { gte: since },
            },
            orderBy: { createdAt: "desc" },
        });
    }

    static async getMoodStats(userId: number) {
        const entries = await this.getMoodHistory(userId, 30);

        if (entries.length === 0) {
            return { average: 0, total: 0, streak: 0, trend: "neutral" as const };
        }

        const average = entries.reduce((sum, e) => sum + e.mood, 0) / entries.length;

        // Calculate streak (consecutive days with entries)
        let streak = 0;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        for (let i = 0; i < 30; i++) {
            const checkDate = new Date(today);
            checkDate.setDate(today.getDate() - i);
            const dateStr = checkDate.toISOString().split("T")[0];

            const hasEntry = entries.some((e) => {
                const entryDate = new Date(e.createdAt).toISOString().split("T")[0];
                return entryDate === dateStr;
            });

            if (hasEntry) {
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

        return {
            average: Math.round(average * 10) / 10,
            total: entries.length,
            streak,
            trend: trend as "improving" | "declining" | "stable",
        };
    }
}
