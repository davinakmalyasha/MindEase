import cron from "node-cron";
import { prisma } from "../lib/prisma";
import { NotificationService } from "../services/notification.service";
import { WaitlistService } from "../services/waitlist.service";
import { logger } from "../utils/logger";

const DAY_MS = 24 * 3600 * 1000;

/**
 * Automated care check-ins (daily):
 * 1. Mood-logging nudge — patients who used to log but haven't in 3 days.
 * 2. Mood-decline nudge — 3-day average ≤ 2.5 with a declining trend.
 * 3. Post-session check-in — 24h after a completed session (review nudge).
 * All are claim-safe for multi-replica deployments and respect notification prefs.
 */
export const runCareCheckins = async () => {
    try {
        const now = new Date();

        // 1. Mood-logging nudge (max once per 3 days per user)
        const moodNudgeCandidates = await prisma.user.findMany({
            where: {
                role: "patient",
                OR: [
                    { lastMoodNudgeAt: null },
                    { lastMoodNudgeAt: { lt: new Date(now.getTime() - 3 * DAY_MS) } },
                ],
            },
            select: { id: true, lastMoodNudgeAt: true },
        });
        for (const user of moodNudgeCandidates) {
            const lastEntry = await prisma.moodEntry.findFirst({
                where: { userId: user.id },
                orderBy: { createdAt: "desc" },
                select: { createdAt: true },
            });
            if (!lastEntry) continue; // never logged — no nudge
            const daysSince = (now.getTime() - lastEntry.createdAt.getTime()) / DAY_MS;
            if (daysSince < 3) continue;

            const claim = await prisma.user.updateMany({
                where: { id: user.id, lastMoodNudgeAt: user.lastMoodNudgeAt },
                data: { lastMoodNudgeAt: now },
            });
            if (claim.count !== 1) continue;

            await NotificationService.create({
                userId: user.id,
                title: "We miss your daily check-in",
                message: "You haven't logged your mood in a few days. A 10-second log helps you spot patterns — and it only takes a tap.",
                type: "system",
                email: true,
            });
        }

        // 2. Mood-decline nudge (max once per week per user)
        const declineCandidates = await prisma.user.findMany({
            where: {
                role: "patient",
                OR: [
                    { lastDeclineNudgeAt: null },
                    { lastDeclineNudgeAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } },
                ],
            },
            select: { id: true, lastDeclineNudgeAt: true },
        });
        for (const user of declineCandidates) {
            const recent = await prisma.moodEntry.findMany({
                where: { userId: user.id },
                orderBy: { createdAt: "desc" },
                take: 6,
                select: { mood: true },
            });
            if (recent.length < 3) continue;
            const moods = recent.map((m) => m.mood);
            const last3 = moods.slice(0, 3);
            const prev3 = moods.slice(3, 6);
            const avg = (arr: number[]) => arr.reduce((s, m) => s + m, 0) / arr.length;
            const lastAvg = avg(last3);
            if (lastAvg > 2.5 || lastAvg >= avg(prev3) - 0.3) continue;

            const claim = await prisma.user.updateMany({
                where: { id: user.id, lastDeclineNudgeAt: user.lastDeclineNudgeAt },
                data: { lastDeclineNudgeAt: now },
            });
            if (claim.count !== 1) continue;

            await NotificationService.create({
                userId: user.id,
                title: "We noticed things feel heavier lately",
                message: "Your recent mood logs are lower than usual. It's okay to ask for support — booking a session with your psychologist can help. You're not alone.",
                type: "system",
                email: true,
            });
        }

        // 3. Post-session check-in (24h after the session START, once per
        // appointment — appointmentDate alone is midnight and would fire early)
        const completed = await prisma.appointment.findMany({
            where: {
                status: "completed",
                checkinSentAt: null,
                appointmentDate: { lte: new Date(now.getTime() - DAY_MS) },
            },
            select: { id: true, userId: true, appointmentDate: true, startTime: true },
        });
        for (const app of completed) {
            const [h, m] = (app.startTime || "00:00").split(":").map(Number);
            const startedAt = new Date(app.appointmentDate);
            startedAt.setHours(h || 0, m || 0, 0, 0);
            if (now.getTime() - startedAt.getTime() < DAY_MS) continue;

            const claim = await prisma.appointment.updateMany({
                where: { id: app.id, checkinSentAt: null },
                data: { checkinSentAt: now },
            });
            if (claim.count !== 1) continue;

            await NotificationService.create({
                userId: app.userId,
                title: "How did your session go?",
                message: "We'd love your feedback. Leaving a review helps your psychologist grow and helps others choose with confidence.",
                type: "appointment",
                email: true,
            });
        }

        // 4. Waitlist hygiene: re-queue stale notifications, expire old entries
        try {
            const maintenance = await WaitlistService.runWaitlistMaintenance();
            if (maintenance.requeued > 0 || maintenance.expiredWaiting > 0) {
                logger.info(maintenance, "Waitlist maintenance completed");
            }
        } catch (err: any) {
            logger.error({ err: err.message }, "Waitlist maintenance failed");
        }
    } catch (err: any) {
        logger.error({ err: err.message }, "Care check-in job failed");
    }
};

export const startCareCheckinJob = () => {
    if (process.env.NODE_ENV === "test") return;
    cron.schedule("0 9 * * *", runCareCheckins, { timezone: "Asia/Jakarta" });
    logger.info("Care check-in job scheduled (daily 09:00 Asia/Jakarta)");
};
