import { describe, it, expect, vi, afterEach } from "vitest";
import { createUser, createDoctor } from "./helpers";
import { prisma } from "../src/app";
import { runCareCheckins } from "../src/jobs/checkins";
import { NotificationService } from "../src/services/notification.service";

const DAY_MS = 24 * 3600 * 1000;

/** See the same helper in `reminders.test.ts`: the job lock outlives a run by design. */
const clearLock = async (key: string) => {
    await prisma.jobLock.deleteMany({ where: { key } });
};

const runCheckins = async () => {
    await clearLock("care-checkins");
    await runCareCheckins();
};

/**
 * The check-in job claims each sentinel *before* sending - that is what makes
 * it replica-safe - and it used to swallow a failed send with
 * `.catch(() => undefined)`, leaving the sentinel claimed and the patient never
 * nudged until the next period (three days for the mood nudge, never for a
 * post-session check-in). The claim now comes back on failure, so the loss is a
 * delay instead of a disappearance.
 *
 * The decline nudge shares `notifyOrRelease`, so these two pin the mechanism
 * for all three blocks: one where the send succeeds and one where it fails and
 * must be retried. The decline rule itself is covered by
 * `mood-decline.test.ts`.
 */
describe("Care check-in job", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("nudges a patient who stopped logging, and releases the claim when the nudge fails", async () => {
        const patient = await createUser("patient");

        // One mood entry, four days old: due for the "we miss you" nudge, and
        // one entry is far below the six the decline rule needs. `moodDate` is
        // the calendar-day key, a string, unique per user.
        const fourDaysAgo = new Date(Date.now() - 4 * DAY_MS);
        await prisma.moodEntry.create({
            data: {
                userId: patient.id,
                mood: 3,
                moodDate: fourDaysAgo.toISOString().slice(0, 10),
                createdAt: fourDaysAgo,
            },
        });

        const create = vi.spyOn(NotificationService, "create").mockResolvedValue(null as any);

        await runCheckins();
        expect(create).toHaveBeenCalledTimes(1);

        const afterNudge = await prisma.user.findUnique({ where: { id: patient.id } });
        expect(afterNudge?.lastMoodNudgeAt).toBeTruthy();

        // Make it due again, and make the notification fail this time.
        const previousNudge = new Date(Date.now() - 5 * DAY_MS);
        await prisma.user.update({
            where: { id: patient.id },
            data: { lastMoodNudgeAt: previousNudge },
        });
        create.mockRejectedValueOnce(new Error("notification insert failed"));

        await runCheckins();
        expect(create).toHaveBeenCalledTimes(2);

        // Handed back to exactly what it was - not null, not "now" - so the
        // three-day clock resumes where it stopped rather than restarting.
        const afterFailure = await prisma.user.findUnique({ where: { id: patient.id } });
        expect(afterFailure?.lastMoodNudgeAt?.getTime()).toBe(previousNudge.getTime());

        // The retry takes the claim again.
        await runCheckins();
        const afterRetry = await prisma.user.findUnique({ where: { id: patient.id } });
        expect(afterRetry?.lastMoodNudgeAt?.getTime()).toBeGreaterThan(previousNudge.getTime());
    });

    it("checks in after a completed session, and releases the claim when it fails", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        // A session that started 25 hours ago, so the post-session check-in is
        // due (the job re-checks the start instant, not the midnight date).
        const startedAt = new Date(Date.now() - 25 * 3600 * 1000);
        const appointmentDate = new Date(startedAt);
        appointmentDate.setHours(0, 0, 0, 0);
        const startTime = `${String(startedAt.getHours()).padStart(2, "0")}:${String(
            startedAt.getMinutes()
        ).padStart(2, "0")}`;

        const appointment = await prisma.appointment.create({
            data: {
                userId: patient.id,
                doctorId: doctor.doctorId,
                appointmentDate,
                startTime,
                endTime: "23:59",
                consultationType: "video",
                status: "completed",
            },
        });

        const create = vi.spyOn(NotificationService, "create").mockRejectedValueOnce(new Error("down"));

        await runCheckins();
        expect(create).toHaveBeenCalledTimes(1);

        const afterFailure = await prisma.appointment.findUnique({ where: { id: appointment.id } });
        expect(afterFailure?.checkinSentAt).toBeNull();

        await runCheckins();
        const afterRetry = await prisma.appointment.findUnique({ where: { id: appointment.id } });
        expect(afterRetry?.checkinSentAt).toBeTruthy();
    });
});
