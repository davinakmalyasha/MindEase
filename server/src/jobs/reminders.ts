import cron from "node-cron";
import { prisma } from "../lib/prisma";
import { MailerService } from "../services/mailer.service";
import { AIService } from "../services/ai.service";
import { WellnessService } from "../services/wellness.service";
import { WhatsAppService } from "../services/wa.service";
import { acquireLock } from "../lib/cache";
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
    // Claim first: only one runner (e.g. one replica of many) wins the
    // updateMany and sends emails. Prevents duplicate reminders when the API
    // runs with multiple instances.
    const claim = await prisma.appointment.updateMany({
        where: { id: appointmentId, reminderSentAt: null },
        data: { reminderSentAt: new Date() },
    });
    if (claim.count !== 1) return;

    const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
            user: { select: { id: true, name: true, email: true, phone_number: true } },
            doctor: { include: { user: { select: { id: true, name: true, email: true, phone_number: true } } } },
        },
    });
    if (!appointment || appointment.status !== "confirmed") return;

    const start = sessionStart(appointment.appointmentDate, appointment.startTime);
    const hoursUntil = (start.getTime() - Date.now()) / 3_600_000;
    if (hoursUntil <= 0 || hoursUntil > REMINDER_WINDOW_HOURS) return;

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
        await prisma.appointment
            .updateMany({ where: { id: appointmentId }, data: { reminderSentAt: null } })
            .catch(() => {});
    }
};

// Exported for integration tests (the cron wrapper itself is skipped in tests).
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
 * Weekly wellness report: emailed every Monday to opted-in patients with a
 * mood summary and AI journal reflection.
 */
export const runWeeklyReports = async () => {
    try {
        // Replica-safe: only one instance runs the Monday blast (Redis lock;
        // no-op fail-open when Redis is down).
        if (!(await acquireLock("weekly-reports", 6 * 3600))) return;

        const users = await prisma.user.findMany({
            where: { weeklyReportEnabled: true, role: "patient" },
            select: { id: true, name: true, email: true },
        });

        for (const user of users) {
            if (!user.email) continue;
            const [stats, journal] = await Promise.all([
                WellnessService.getMoodStats(user.id),
                WellnessService.getJournalEntries(user.id, 7),
            ]);

            let summary: string | null = null;
            if (journal.length > 0) {
                summary = await AIService.summarizeJournal(
                    journal.map((j) => j.content),
                    journal[journal.length - 1].createdAt,
                    journal[0].createdAt
                );
            }

            const { subject, html } = MailerService.buildWeeklyReportEmail({
                name: user.name || "there",
                averageMood: stats.average,
                streak: stats.streak,
                trend: stats.trend,
                journalCount: journal.length,
                aiSummary: summary,
            });
            await MailerService.send(user.email, subject, html).catch((err) =>
                logger.error({ err: err.message, userId: user.id }, "Weekly report email failed")
            );
        }
    } catch (err: any) {
        logger.error({ err: err.message }, "Weekly report job failed");
    }
};

/**
 * Starts the in-process appointment reminder job (every 10 minutes).
 * Emails patients and doctors 0–24h before a confirmed session, once per
 * appointment. No-op in test mode.
 */
export const startReminderJob = () => {
    if (process.env.NODE_ENV === "test") return;
    cron.schedule("*/10 * * * *", runReminders, { timezone: "Asia/Jakarta" });
    cron.schedule("0 7 * * 1", runWeeklyReports, { timezone: "Asia/Jakarta" });
    logger.info("Reminder + weekly report jobs scheduled (Asia/Jakarta)");
};
