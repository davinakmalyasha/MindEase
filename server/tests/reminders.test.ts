import { describe, it, expect } from "vitest";
import { createUser, createDoctor } from "./helpers";
import { prisma } from "../src/app";
import { runReminders } from "../src/jobs/reminders";

const inTwoHours = () => {
    const d = new Date(Date.now() + 2 * 3_600_000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

describe("Appointment reminder job", () => {
    it("emails once for confirmed appointments within 24h and dedupes on reruns", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        const appointment = await prisma.appointment.create({
            data: {
                userId: patient.id,
                doctorId: doctor.doctorId,
                appointmentDate: new Date(),
                startTime: inTwoHours(),
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
                appointmentDate: new Date(),
                startTime: inTwoHours(),
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
