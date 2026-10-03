import { describe, it, expect } from "vitest";
import { createUser, createDoctor, app } from "./helpers";
import { prisma } from "../src/app";
import request from "supertest";

/**
 * Regression tests for the data-integrity defects fixed at the end of phase 2.
 *
 * Each of these was a silent state corruption rather than a visible failure:
 * a slot advertised as free while an appointment still referenced it, a profile
 * offering a clinician who was on leave, and a same-day mood re-log that
 * discarded the first entry without telling anyone.
 */

const dayAt = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(0, 0, 0, 0);
    return d;
};

const dayKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const createOpenSlot = async (doctorId: number, days: number, start: string, end: string) =>
    prisma.consultationSlot.create({
        data: { doctorId, date: dayAt(days), startTime: start, endTime: end, isBooked: false },
    });

const bookSlot = async (
    patient: Awaited<ReturnType<typeof createUser>>,
    doctorId: number,
    slotId: number | undefined,
    date: string,
    start: string,
    end: string,
    key: string
) =>
    patient.agent
        .post("/api/appointments/book")
        .set("X-CSRF-Token", patient.csrf)
        .send({
            doctorId,
            ...(slotId === undefined ? {} : { slotId }),
            appointmentDate: date,
            startTime: start,
            endTime: end,
            consultationType: "video",
            idempotencyKey: key,
        });

describe("reschedule slot bookkeeping", () => {
    // The defect: `slotId` was assigned even when the request kept the
    // appointment's existing slot and therefore claimed nothing. The conflict
    // and catch paths then released that slot, so it was advertised as free
    // while Appointment.slotId still pointed at it — the next patient to take
    // it double-booked the clinician.
    it("does not release the slot it still holds when the new time conflicts", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const mine = await createOpenSlot(doctor.doctorId, 3, "10:00", "12:00");

        const booked = await bookSlot(
            patient,
            doctor.doctorId,
            mine.id,
            dayKey(dayAt(3)),
            "10:00",
            "11:00",
            "same-slot-setup"
        );
        expect(booked.status).toBe(201);
        const appointmentId = booked.body.data.id;

        // A second patient takes the 11:00-12:00 part of the same day via a
        // free-text booking. No overlap with the original 10:00-11:00, so the
        // booking succeeds.
        const other = await createUser("patient");
        const adjacent = await bookSlot(
            other,
            doctor.doctorId,
            undefined,
            dayKey(dayAt(3)),
            "11:00",
            "12:00",
            "same-slot-adjacent"
        );
        expect(adjacent.status).toBe(201);

        // The patient now asks to move *within* the same day, keeping the very
        // slot they already hold, into the hours the other patient took.
        // The conflict check excludes this appointment but not the other, so it
        // correctly rejects — and must leave the slot booked.
        const res = await patient.agent
            .put(`/api/appointments/${appointmentId}/reschedule`)
            .set("X-CSRF-Token", patient.csrf)
            .send({
                slotId: mine.id,
                appointmentDate: dayKey(dayAt(3)),
                startTime: "11:00",
                endTime: "12:00",
            });

        expect(res.status).toBe(409, `unexpected body: ${JSON.stringify(res.body)}`);

        const after = await prisma.consultationSlot.findUnique({ where: { id: mine.id } });
        expect(after?.isBooked).toBe(true);

        const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
        expect(appointment?.slotId).toBe(mine.id);
    });

    it("releases a newly claimed slot when the reschedule conflicts", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const original = await createOpenSlot(doctor.doctorId, 3, "10:00", "11:00");
        const target = await createOpenSlot(doctor.doctorId, 5, "14:00", "15:00");

        const booked = await bookSlot(
            patient,
            doctor.doctorId,
            original.id,
            dayKey(dayAt(3)),
            "10:00",
            "11:00",
            "conflict-release-setup"
        );
        expect(booked.status).toBe(201);

        // Another patient holds an overlapping booking on the target day. A
        // free-text booking (no slot) still occupies the doctor's time.
        const other = await createUser("patient");
        const conflict = await bookSlot(
            other,
            doctor.doctorId,
            undefined,
            dayKey(dayAt(5)),
            "14:30",
            "15:30",
            "conflict-other"
        );
        expect(conflict.status).toBe(201);

        const res = await patient.agent
            .put(`/api/appointments/${booked.body.data.id}/reschedule`)
            .set("X-CSRF-Token", patient.csrf)
            .send({
                slotId: target.id,
                appointmentDate: dayKey(dayAt(5)),
                startTime: "14:00",
                endTime: "15:00",
            });

        expect(res.status).toBeGreaterThanOrEqual(400);

        // A slot this request claimed and then could not use must go back.
        const after = await prisma.consultationSlot.findUnique({ where: { id: target.id } });
        expect(after?.isBooked).toBe(false);
    });

    it("moves the booking and releases the old slot on success", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const original = await createOpenSlot(doctor.doctorId, 3, "10:00", "11:00");
        const target = await createOpenSlot(doctor.doctorId, 6, "09:00", "10:00");

        const booked = await bookSlot(
            patient,
            doctor.doctorId,
            original.id,
            dayKey(dayAt(3)),
            "10:00",
            "11:00",
            "move-setup"
        );
        expect(booked.status).toBe(201);

        const res = await patient.agent
            .put(`/api/appointments/${booked.body.data.id}/reschedule`)
            .set("X-CSRF-Token", patient.csrf)
            .send({
                slotId: target.id,
                appointmentDate: dayKey(dayAt(6)),
                startTime: "09:00",
                endTime: "10:00",
            });

        expect(res.status).toBe(200);

        const oldSlot = await prisma.consultationSlot.findUnique({ where: { id: original.id } });
        const newSlot = await prisma.consultationSlot.findUnique({ where: { id: target.id } });
        expect(oldSlot?.isBooked).toBe(false);
        expect(newSlot?.isBooked).toBe(true);

        const appointment = await prisma.appointment.findUnique({
            where: { id: booked.body.data.id },
        });
        expect(appointment?.slotId).toBe(target.id);
    });
});

describe("away window is reflected in the public profile", () => {
    // The defect: the profile's nested `consultationSlots` filtered only
    // `isBooked: false`, unlike the booking endpoint, so a clinician on leave
    // still advertised their pre-created slots to anonymous visitors.
    it("hides slots inside the away window from the public profile", async () => {
        const doctor = await createDoctor();
        await createOpenSlot(doctor.doctorId, 2, "10:00", "11:00"); // inside away window
        await createOpenSlot(doctor.doctorId, 40, "10:00", "11:00"); // well after it

        const awayUntil = dayAt(3);
        await prisma.doctor.update({
            where: { id: doctor.doctorId },
            data: { awayUntil },
        });

        const lookup = await request(app).get(`/api/doctors/${doctor.doctorId}`);

        expect(lookup.status).toBe(200);
        const slots = lookup.body?.data?.consultationSlots ?? [];
        const dates = slots.map((s: { date: string }) => dayKey(new Date(s.date)));
        expect(dates).not.toContain(dayKey(dayAt(2)));
        expect(dates).toContain(dayKey(dayAt(40)));
    });

    it("does not hide slots once the away window has elapsed", async () => {
        const doctor = await createDoctor();
        await createOpenSlot(doctor.doctorId, 5, "10:00", "11:00");

        // An away date in the past must be ignored rather than hiding everything.
        await prisma.doctor.update({
            where: { id: doctor.doctorId },
            data: { awayUntil: dayAt(-2) },
        });

        const lookup = await request(app).get(`/api/doctors/${doctor.doctorId}`);

        expect(lookup.status).toBe(200);
        const slots = lookup.body?.data?.consultationSlots ?? [];
        const dates = slots.map((s: { date: string }) => dayKey(new Date(s.date)));
        expect(dates).toContain(dayKey(dayAt(5)));
    });
});

describe("mood re-log is honest about replacement", () => {
    // The defect: the one-entry-per-day upsert overwrote the earlier entry
    // silently, so a mis-tap destroyed a real check-in and the UI still said
    // "Mood logged", implying a new entry.
    it("reports replacement instead of implying a fresh log", async () => {
        const user = await createUser("patient");

        const first = await user.agent
            .post("/api/wellness/mood")
            .set("X-CSRF-Token", user.csrf)
            .send({ mood: 2, notes: "anxious" });
        expect(first.status).toBe(201);
        expect(first.body.data.replaced).toBe(false);

        const second = await user.agent
            .post("/api/wellness/mood")
            .set("X-CSRF-Token", user.csrf)
            .send({ mood: 4, notes: "better after a walk" });
        expect(second.status).toBe(201);
        expect(second.body.data.replaced).toBe(true);

        // The day's entry was updated in place, not duplicated.
        const entries = await prisma.moodEntry.findMany({ where: { userId: user.userId } });
        expect(entries).toHaveLength(1);
        expect(entries[0].mood).toBe(4);
        expect(entries[0].notes).toBe("better after a walk");
    });
});
