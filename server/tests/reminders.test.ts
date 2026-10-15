import { describe, it, expect, vi, afterEach } from "vitest";
import { createUser, createDoctor } from "./helpers";
import { prisma } from "../src/app";
import { runReminders, runWeeklyReports } from "../src/jobs/reminders";
import { MailerService } from "../src/services/mailer.service";

/**
 * Clears the lock `acquireLock` would have taken, whichever backend it chose.
 *
 * With Redis running, the Redis key is released at the end of a run and this is
 * a no-op. Without Redis (CI), the lock is a `JobLock` row whose TTL outlives
 * the run by design - correct for a daily cron, but it would silently gate the
 * second run of a test. Deleting the row is how a test simulates "an hour
 * later".
 */
const clearLock = async (key: string) => {
    await prisma.jobLock.deleteMany({ where: { key } });
};

/**
 * A confirmed session that starts `hours` from now.
 *
 * `appointmentDate` and `startTime` are stored separately — the job rebuilds the
 * instant with `setHours` on the stored date — so both halves have to be derived
 * from the same instant. Deriving only the time-of-day from "now + N hours" broke
 * this suite every evening: at 22:00 local, "now + 2h" wraps to "00:21", which
 * combined with *today's* date resolved to 22 hours in the past, so eligibility
 * correctly rejected it and the test failed for reasons unrelated to the job.
 */
const startingIn = (hours: number) => {
    const at = new Date(Date.now() + hours * 3_600_000);
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    return {
        date,
        startTime: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`,
    };
};

describe("Appointment reminder job", () => {
    it("emails once for confirmed appointments within 24h and dedupes on reruns", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        const appointment = await prisma.appointment.create({
            data: {
                userId: patient.id,
                doctorId: doctor.doctorId,
                appointmentDate: startingIn(2).date,
                startTime: startingIn(2).startTime,
                endTime: "23:59",
                consultationType: "video",
                status: "confirmed",
            },
        });

        await runReminders();

        const afterFirst = await prisma.appointment.findUnique({ where: { id: appointment.id } });
        expect(afterFirst?.reminderSentAt).toBeTruthy();

        const firstStamp = afterFirst?.reminderSentAt?.getTime();

        await runReminders();

        const afterSecond = await prisma.appointment.findUnique({ where: { id: appointment.id } });
        expect(afterSecond?.reminderSentAt?.getTime()).toBe(firstStamp);
    });

    it("skips appointments further than 24h away", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        const far = new Date(Date.now() + 48 * 3_600_000);
        far.setMinutes(0, 0, 0);
        const startTime = `${String(far.getHours()).padStart(2, "0")}:00`;

        const appointment = await prisma.appointment.create({
            data: {
                userId: patient.id,
                doctorId: doctor.doctorId,
                appointmentDate: far,
                startTime,
                endTime: "23:59",
                consultationType: "chat",
                status: "confirmed",
            },
        });

        await runReminders();

        const after = await prisma.appointment.findUnique({ where: { id: appointment.id } });
        expect(after?.reminderSentAt).toBeNull();
    });

    it("sends only once when two runners race (multi-replica safety)", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        const appointment = await prisma.appointment.create({
            data: {
                userId: patient.id,
                doctorId: doctor.doctorId,
                appointmentDate: startingIn(2).date,
                startTime: startingIn(2).startTime,
                endTime: "23:59",
                consultationType: "video",
                status: "confirmed",
            },
        });

        await Promise.all([runReminders(), runReminders()]);

        const after = await prisma.appointment.findUnique({ where: { id: appointment.id } });
        expect(after?.reminderSentAt).toBeTruthy();

        // A third run must not touch it (already claimed)
        await runReminders();
        const final = await prisma.appointment.findUnique({ where: { id: appointment.id } });
        expect(final?.reminderSentAt?.getTime()).toBe(after?.reminderSentAt?.getTime());
    });
});

describe("Weekly wellness report job", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * The old schedule was `0 7 * * 1` with one six-hour lock for the whole
     * blast: a missed Monday lost the week, and a crash mid-loop either
     * re-mailed everyone already reached or blocked the retry. The claim is
     * `lastWeeklyReportAt`, checked against this week's Monday.
     */
    it("sends once per week, skips the same week, and catches up a missed one", async () => {
        const send = vi.spyOn(MailerService, "send").mockResolvedValue({ devFallback: true } as any);

        const optedIn = await createUser("patient");
        await prisma.user.update({ where: { id: optedIn.id }, data: { weeklyReportEnabled: true } });
        // Default is opted out; the send count below pins that they stay out.
        await createUser("patient");

        await clearLock("weekly-reports");
        await runWeeklyReports();
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toBe(optedIn.email);

        const afterFirst = await prisma.user.findUnique({ where: { id: optedIn.id } });
        expect(afterFirst?.lastWeeklyReportAt).toBeTruthy();

        // Same week: the claim holds, and no second email goes out.
        await clearLock("weekly-reports");
        await runWeeklyReports();
        expect(send).toHaveBeenCalledTimes(1);

        // A week the patient missed: the timestamp predates this week's Monday,
        // so the very next daily run catches it up rather than waiting.
        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3_600_000);
        await prisma.user.update({
            where: { id: optedIn.id },
            data: { lastWeeklyReportAt: eightDaysAgo },
        });
        await clearLock("weekly-reports");
        await runWeeklyReports();
        expect(send).toHaveBeenCalledTimes(2);

        const afterCatchUp = await prisma.user.findUnique({ where: { id: optedIn.id } });
        expect(afterCatchUp?.lastWeeklyReportAt?.getTime()).toBeGreaterThan(eightDaysAgo.getTime());
    });

    it("hands the week back when the send fails, so the next run retries", async () => {
        const send = vi.spyOn(MailerService, "send").mockResolvedValue({ devFallback: true } as any);

        const patient = await createUser("patient");
        await prisma.user.update({ where: { id: patient.id }, data: { weeklyReportEnabled: true } });

        send.mockRejectedValueOnce(new Error("SMTP down"));

        await clearLock("weekly-reports");
        await runWeeklyReports();
        expect(send).toHaveBeenCalledTimes(1);

        const afterFailure = await prisma.user.findUnique({ where: { id: patient.id } });
        expect(afterFailure?.lastWeeklyReportAt).toBeNull();

        // The retry succeeds and takes the week.
        await clearLock("weekly-reports");
        await runWeeklyReports();
        expect(send).toHaveBeenCalledTimes(2);

        const afterRetry = await prisma.user.findUnique({ where: { id: patient.id } });
        expect(afterRetry?.lastWeeklyReportAt).toBeTruthy();
    });

    it("sends once when two runners race (multi-replica safety)", async () => {
        const send = vi.spyOn(MailerService, "send").mockResolvedValue({ devFallback: true } as any);

        const patient = await createUser("patient");
        await prisma.user.update({ where: { id: patient.id }, data: { weeklyReportEnabled: true } });

        await clearLock("weekly-reports");
        await Promise.all([runWeeklyReports(), runWeeklyReports()]);
        expect(send).toHaveBeenCalledTimes(1);
    });
});
