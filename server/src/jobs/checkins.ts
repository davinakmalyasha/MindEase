import cron from "node-cron";
import { prisma } from "../lib/prisma";
import { NotificationService } from "../services/notification.service";
import { raiseRiskAlert } from "../services/clinicalSafety.service";
import { WaitlistService } from "../services/waitlist.service";
import { logger } from "../utils/logger";
import { acquireLock, releaseLock } from "../lib/cache";

const DAY_MS = 24 * 3600 * 1000;

/**
 * Upper bound on candidates read per block per run.
 *
 * The job runs daily, so a platform-wide gap in logging is worked through over
 * several days rather than in one unbounded fetch. The clinical rules below are
 * unchanged: this only stops the candidate query returning the whole patient
 * table.
 */
const CANDIDATE_CAP = 2000;

/**
 * Automated care check-ins (daily):
 * 1. Mood-logging nudge — patients who used to log but haven't in 3 days.
 * 2. Mood-decline nudge — 3-day average ≤ 2.5 with a declining trend.
 * 3. Post-session check-in — 24h after a completed session (review nudge).
 * All are claim-safe for multi-replica deployments and respect notification prefs.
 */
export const runCareCheckins = async () => {
    // Single-runner gate, before anything is read.
    //
    // The per-user `updateMany` claims below already prevent duplicate *sends*,
    // which is why the cost of this running on every replica went unnoticed:
    // claims do nothing about the scans. Two full `User` reads, then a
    // `moodEntry` query per candidate, and `NotificationService.create` costs up
    // to four more queries each — roughly 120k queries per run at 10k patients,
    // multiplied by the replica count, to produce the same notifications.
    //
    // `runWeeklyReports` already takes this lock; this job did not. The lock is
    // best-effort — `cache.ts` documents that its `GET_LOCK` fallback cannot work
    // as written — so the claims remain the correctness guarantee and this is
    // only an optimisation.
    const locked = await acquireLock("care-checkins", 3600);
    if (!locked) return;

    try {
        const now = new Date();

        // 1. Mood-logging nudge (max once per 3 days per user)
        const moodNudgeCandidates = await prisma.user.findMany({
            where: {
                role: "patient",
                // A suspended account should not be nudged, and a banned one
                // should not be readable here at all.
                isBanned: false,
                OR: [
                    { lastMoodNudgeAt: null },
                    { lastMoodNudgeAt: { lt: new Date(now.getTime() - 3 * DAY_MS) } },
                ],
            },
            select: { id: true, lastMoodNudgeAt: true },
            orderBy: { id: "asc" },
            take: CANDIDATE_CAP,
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
            }).catch(() => undefined);
        }

        // 2. Mood-decline nudge (max once per week per user)
        const declineCandidates = await prisma.user.findMany({
            where: {
                role: "patient",
                isBanned: false,
                OR: [
                    { lastDeclineNudgeAt: null },
                    { lastDeclineNudgeAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } },
                ],
            },
            select: { id: true, lastDeclineNudgeAt: true },
            orderBy: { id: "asc" },
            take: CANDIDATE_CAP,
        });
        for (const user of declineCandidates) {
            // Six entries, not three.
            //
            // The rule is "3-day average at or below 2.5 AND declining", so it
            // needs two windows to compare. With exactly three entries `prev3` was
            // empty, `avg([])` is `NaN`, and `lastAvg >= NaN - 0.3` is false - so
            // the `continue` below never fired and the nudge went out on the
            // strength of a comparison against nothing. A patient with three
            // low-ish logs was told their mood was declining when nothing had been
            // compared to anything.
            const recent = await prisma.moodEntry.findMany({
                where: { userId: user.id },
                orderBy: { createdAt: "desc" },
                take: 6,
                select: { id: true, mood: true, moodDate: true },
            });
            if (recent.length < 6) continue;
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
            }).catch(() => undefined);

            // ...and the clinician hears about it too.
            //
            // This is the gap the README, ARCHITECTURE.md and docs/roadmap.md all
            // admitted: "the decline nudge notifies the patient" and "a clinician
            // sees a declining patient" were different claims and only the first
            // was true. `RiskAlert.sourceType` reserves `mood` for exactly this,
            // the client's risk queue already renders `source_mood`, and no code
            // anywhere wrote the value - so the one signal that predicts a
            // deterioration over days stopped at the patient.
            //
            // `elevated`, not `urgent`: a sustained downward trend is a reason for
            // a clinician to reach out today, not a disclosure of imminent risk.
            // The SOS and PHQ-9 item 9 paths remain the urgent ones.
            //
            // `sourceId` is the most recent log, so a clinician reading the queue
            // item can go straight to the evidence. Not awaited-and-thrown: the
            // patient nudge above has already been sent, and an escalation failure
            // must not roll that back.
            await raiseRiskAlert({
                userId: user.id,
                level: "elevated",
                reason: `Mood logs have declined: the last three entries average ${lastAvg.toFixed(1)}/5 against ${avg(prev3).toFixed(1)}/5 for the three before them.`,
                sourceType: "mood",
                sourceId: recent[0].id,
            }).catch((err: unknown) => {
                logger.error(
                    { err: err instanceof Error ? err.message : String(err), userId: user.id },
                    "Mood-decline risk alert could not be raised"
                );
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
            orderBy: { id: "asc" },
            take: CANDIDATE_CAP,
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
            }).catch(() => undefined);
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
    } finally {
        await releaseLock("care-checkins");
    }
};

export const startCareCheckinJob = () => {
    if (process.env.NODE_ENV === "test") return;
    cron.schedule("0 9 * * *", runCareCheckins, { timezone: "Asia/Jakarta" });
    logger.info("Care check-in job scheduled (daily 09:00 Asia/Jakarta)");
};
