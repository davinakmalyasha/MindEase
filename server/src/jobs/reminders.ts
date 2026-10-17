import { prisma } from "../lib/prisma";
import { MailerService } from "../services/mailer.service";
import { AIService } from "../services/ai.service";
import { WellnessService } from "../services/wellness.service";
import { WhatsAppService } from "../services/wa.service";
import { acquireLock, releaseLock } from "../lib/cache";
import { logger } from "../utils/logger";

const formatDate = (d: Date) =>
    d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

const sessionStart = (appointmentDate: Date, startTime: string | null) => {
    const d = new Date(appointmentDate);
    const [h, m] = (startTime || "00:00").split(":").map(Number);
    d.setHours(h || 0, m || 0, 0, 0);
    return d;
};

const REMINDER_WINDOW_HOURS = 24;

const sendReminder = async (appointmentId: number) => {
    const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
            user: { select: { id: true, name: true, email: true, phone_number: true } },
            doctor: { include: { user: { select: { id: true, name: true, email: true, phone_number: true } } } },
        },
    });
    if (!appointment || appointment.status !== "confirmed") return;

    // Eligibility is checked BEFORE the claim.
    //
    // The claim used to be taken first and the window verified afterwards, so
    // any session whose calendar *date* fell inside the 24h horizon but whose
    // actual start did not — a late-evening session the next day, for
    // instance — burned `reminderSentAt` and was then skipped on every future
    // run. The patient was never reminded and nothing ever reported the loss.
    const start = sessionStart(appointment.appointmentDate, appointment.startTime);
    const hoursUntil = (start.getTime() - Date.now()) / 3_600_000;
    if (hoursUntil <= 0 || hoursUntil > REMINDER_WINDOW_HOURS) return;

    // Claim now that the session is known to be due: only one runner (e.g. one
    // replica of many) wins the updateMany and sends. Prevents duplicate
    // reminders when the API runs with multiple instances.
    const claim = await prisma.appointment.updateMany({
        where: { id: appointmentId, reminderSentAt: null },
        data: { reminderSentAt: new Date() },
    });
    if (claim.count !== 1) return;

    // Belt and braces: if anything below returns early, hand the claim back so
    // the next run can retry rather than stranding the reminder.
    const releaseClaim = () =>
        prisma.appointment
            .updateMany({ where: { id: appointmentId }, data: { reminderSentAt: null } })
            .catch(() => {});

    const patient = appointment.user;
    const doctor = appointment.doctor.user;
    const dateLabel = formatDate(start);

    const jobs: Promise<void>[] = [];

    if (patient.email) {
        const { subject, html } = MailerService.buildReminderEmail({
            name: patient.name || "there",
            counterpartName: doctor.name || "your doctor",
            date: dateLabel,
            time: appointment.startTime || "",
            type: appointment.consultationType,
            isPatient: true,
        });
        jobs.push(MailerService.send(patient.email, subject, html).then(() => undefined));
    }
    if (doctor.email) {
        const { subject, html } = MailerService.buildReminderEmail({
            name: doctor.name || "Doctor",
            counterpartName: patient.name || "a patient",
            date: dateLabel,
            time: appointment.startTime || "",
            type: appointment.consultationType,
            isPatient: false,
        });
        jobs.push(MailerService.send(doctor.email, subject, html).then(() => undefined));
    }

    // WhatsApp reminders when a phone number is on file (best-effort, email remains primary)
    if (patient.phone_number) {
        jobs.push(
            WhatsAppService.send(
                patient.phone_number,
                `MindEase reminder: your ${appointment.consultationType} session with ${doctor.name || "your doctor"} is on ${dateLabel} at ${appointment.startTime || ""}. Reply to your dashboard to reschedule if needed.`
            ).then(() => undefined)
        );
    }
    if (doctor.phone_number) {
        jobs.push(
            WhatsAppService.send(
                doctor.phone_number,
                `MindEase reminder: you have a ${appointment.consultationType} session with ${patient.name || "a patient"} on ${dateLabel} at ${appointment.startTime || ""}.`
            ).then(() => undefined)
        );
    }

    // If EVERY delivery failed (e.g. SMTP down in production), release the
    // claim so the next run retries instead of silently consuming it.
    const results = await Promise.allSettled(jobs);
    if (jobs.length > 0 && results.every((r) => r.status === "rejected")) {
        await releaseClaim();
    }
};

// Exported for integration tests and the job registry; the scheduler that calls
// it is skipped in tests.
export const runReminders = async () => {
    try {
        const now = new Date();
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const horizon = new Date(now.getTime() + REMINDER_WINDOW_HOURS * 3_600_000);

        // appointmentDate is the local midnight of the session day — using
        // startOfToday (instead of `now`) so same-day sessions are included;
        // sendReminder re-checks the exact 0–24h window per appointment.
        const due = await prisma.appointment.findMany({
            where: {
                status: "confirmed",
                reminderSentAt: null,
                appointmentDate: { gte: startOfToday, lte: horizon },
            },
            select: { id: true },
        });

        for (const a of due) {
            await sendReminder(a.id);
        }
    } catch (err: any) {
        logger.error({ err: err.message }, "Reminder job failed");
    }
};

/**
 * The start of the current week in the product timezone: Monday 00:00 WIB.
 *
 * WIB is UTC+7 with no daylight saving, so a fixed offset is exact and no
 * timezone database is involved. The cron fires in Asia/Jakarta; the report's
 * "week" has to be the same calendar its recipients live in, or a Monday-morning
 * tick could put the boundary a day off for everyone.
 */
const startOfWeekWib = (now: Date = new Date()) => {
    const wib = new Date(now.getTime() + 7 * 3_600_000);
    const sinceMonday = (wib.getUTCDay() + 6) % 7;
    wib.setUTCDate(wib.getUTCDate() - sinceMonday);
    wib.setUTCHours(0, 0, 0, 0);
    return new Date(wib.getTime() - 7 * 3_600_000);
};

/**
 * Weekly wellness report: emailed to opted-in patients with a mood summary and
 * AI journal reflection.
 *
 * Runs daily, not on Mondays, and each patient is claimed for the week before
 * their report is built. Both halves are the fix for the same fragility:
 *
 *  - **A missed Monday lost the week.** The old schedule was `0 7 * * 1`, so an
 *    outage, a deploy or a crash at 07:00 meant nobody received anything until
 *    the following Monday, and nothing recorded that the week had been skipped.
 *  - **A crash mid-loop re-mailed or dropped people.** The only safety was a
 *    six-hour lock for the whole blast, so a run that died after twenty emails
 *    either blocked the retry for hours or (after expiry) sent those twenty
 *    again. There was no per-patient record of who had been reached.
 *
 * `lastWeeklyReportAt` is that record: the claim is one conditional update per
 * patient, the due check is "older than this week's Monday", and a failed send
 * hands the claim back. A run that dies halfway resumes on the next daily tick
 * with the remainder, and nobody is mailed twice.
 */
export const runWeeklyReports = async () => {
    // Scan gate only - the per-patient claim below is the correctness
    // guarantee, exactly as in the check-in job.
    if (!(await acquireLock("weekly-reports", 3600))) return;

    try {
        const weekStart = startOfWeekWib();
        const users = await prisma.user.findMany({
            where: {
                weeklyReportEnabled: true,
                role: "patient",
                // A suspended account is not mailed; the check-in nudges made
                // the same decision and this query was the one that ignored it.
                isBanned: false,
                OR: [{ lastWeeklyReportAt: null }, { lastWeeklyReportAt: { lt: weekStart } }],
            },
            select: { id: true, name: true, email: true, lastWeeklyReportAt: true },
        });

        let sent = 0;
        let failed = 0;

        for (const user of users) {
            if (!user.email) continue;

            const claimedAt = new Date();
            const claim = await prisma.user.updateMany({
                where: { id: user.id, lastWeeklyReportAt: user.lastWeeklyReportAt },
                data: { lastWeeklyReportAt: claimedAt },
            });
            if (claim.count !== 1) continue;

            // Hand the week back if anything below fails, so the loss is a
            // delay rather than a disappearance.
            const releaseClaim = () =>
                prisma.user
                    .updateMany({
                        where: { id: user.id, lastWeeklyReportAt: claimedAt },
                        data: { lastWeeklyReportAt: user.lastWeeklyReportAt },
                    })
                    .catch(() => undefined);

            try {
                const [stats, journal] = await Promise.all([
                    WellnessService.getMoodStats(user.id),
                    WellnessService.getJournalEntries(user.id, 7),
                ]);

                let summary: string | null = null;
                if (journal.length > 0) {
                    const generated = await AIService.summarizeJournal(
                        journal.map((j) => j.content),
                        new Date(journal[journal.length - 1].createdAt),
                        new Date(journal[0].createdAt)
                    );
                    summary = generated.data;
                    // An emailed report is the one place the reader cannot inspect a
                    // response body, so a fallback has to be visible in the prose
                    // itself — otherwise "your week in reflection" reads as a
                    // considered personal synthesis when it was a fixed paragraph.
                    if (generated.source === "fallback") {
                        summary = `${generated.data}\n\n(Automated — our AI reflection was unavailable, so this is a standard note rather than a personal summary.)`;
                    }
                }

                const { subject, html } = MailerService.buildWeeklyReportEmail({
                    name: user.name || "there",
                    averageMood: stats.average,
                    streak: stats.streak,
                    trend: stats.trend,
                    journalCount: journal.length,
                    aiSummary: summary,
                });
                await MailerService.send(user.email, subject, html);
                sent += 1;
            } catch (err: any) {
                failed += 1;
                await releaseClaim();
                logger.error({ err: err.message, userId: user.id }, "Weekly report failed; claim released for retry");
            }
        }

        if (sent > 0 || failed > 0) {
            logger.info({ sent, failed, weekStart }, "Weekly reports run complete");
        }
    } catch (err: any) {
        logger.error({ err: err.message }, "Weekly report job failed");
    } finally {
        await releaseLock("weekly-reports");
    }
};
