import { describe, it, expect } from "vitest";
import { createUser, createDoctor } from "./helpers";
import { prisma } from "../src/app";
import { runReminders } from "../src/jobs/reminders";

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
