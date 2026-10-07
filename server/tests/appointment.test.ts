import { describe, it, expect } from "vitest";
import { createUser, createDoctor } from "./helpers";
import { prisma } from "../src/app";

const futureDate = (days = 3) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
};

const createOpenSlot = async (doctorId: number, days = 3, start = "10:00", end = "11:00") => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    date.setHours(0, 0, 0, 0);
    return prisma.consultationSlot.create({
        data: { doctorId, date, startTime: start, endTime: end, isBooked: false },
    });
};

describe("Appointments", () => {
    it("books a slot and locks it", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const slot = await createOpenSlot(doctor.doctorId);

        const res = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: doctor.doctorId,
                slotId: slot.id,
                appointmentDate: futureDate(),
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
                notes: "Feeling anxious",
                idempotencyKey: "test-key-1",
            });

        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe("pending");

        const locked = await prisma.consultationSlot.findUnique({ where: { id: slot.id } });
        expect(locked?.isBooked).toBe(true);
    });

    it("replays the same idempotency key without creating a duplicate", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const slot = await createOpenSlot(doctor.doctorId);

        const payload = {
            doctorId: doctor.doctorId,
            slotId: slot.id,
            appointmentDate: futureDate(),
            startTime: "10:00",
            endTime: "11:00",
            consultationType: "video",
            idempotencyKey: "idem-test-2",
        };

        const first = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send(payload);
        expect(first.status).toBe(201);

        const replay = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send(payload);
        expect(replay.status).toBe(201);
        expect(replay.body.data.id).toBe(first.body.data.id);

        const count = await prisma.appointment.count({ where: { userId: patient.id } });
        expect(count).toBe(1);
    });

    it("rejects double-booking the same slot", async () => {
        const patient = await createUser("patient");
        const other = await createUser("patient");
        const doctor = await createDoctor();
        const slot = await createOpenSlot(doctor.doctorId);

        const payload = {
            doctorId: doctor.doctorId,
            slotId: slot.id,
            appointmentDate: futureDate(),
            startTime: "10:00",
            endTime: "11:00",
            consultationType: "video",
        };
        const first = await patient.agent.post("/api/appointments/book").set("X-CSRF-Token", patient.csrf).send(payload);
        expect(first.status).toBe(201);

        const second = await other.agent.post("/api/appointments/book").set("X-CSRF-Token", other.csrf).send(payload);
        // 409 Conflict: the slot is taken. This used to be 400 only because the
        // controller hard-coded a status instead of reading the typed error.
        expect(second.status).toBe(409);
        expect(second.body.message).toContain("already booked");
    });

    it("rejects past appointments", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const res = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: doctor.doctorId,
                appointmentDate: "2020-01-01",
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
            });
        expect(res.status).toBe(400);
        expect(res.body.message).toContain("past");
    });

    it("rejects overlapping bookings for the same doctor", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const date = futureDate();
        const first = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, appointmentDate: date, startTime: "10:00", endTime: "11:00", consultationType: "video" });
        expect(first.status).toBe(201);

        const overlap = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, appointmentDate: date, startTime: "10:30", endTime: "11:30", consultationType: "video" });
        // 409 Conflict: the clinician is already booked for an overlapping hour.
        expect(overlap.status).toBe(409);
    });

    it("confirms on doctor approval without minting a public meeting link", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const slot = await createOpenSlot(doctor.doctorId);
        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, slotId: slot.id, appointmentDate: futureDate(), startTime: "10:00", endTime: "11:00", consultationType: "video" });
        const appId = book.body.data.id;

        const confirm = await doctor.agent
            .put(`/api/appointments/${appId}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "confirmed" });
        expect(confirm.status).toBe(200);

        // The suite runs with VIDEO_PROVIDER=livekit, which is the production
        // configuration. Previously this asserted `meetingLink` contained
        // "meet.jit.si", which meant the only room the test suite ever exercised
        // was the unauthenticated fallback - the token path, the thing that
        // actually secures a consultation, was untested end to end.
        // `appointment.service.ts:504` only writes a meeting link when the
        // active provider is jitsi, so under livekit there must be none: a
        // stray third-party URL sitting on the row would be the old behaviour
        // leaking through. The jitsi path is covered by
        // `video-fallback.test.ts`.
        expect(confirm.body.data.meetingLink).toBeNull();

        // The per-appointment room seed is what the room name is derived from,
        // so it is written at confirmation and not at join time.
        const updated = await prisma.appointment.findUnique({ where: { id: appId } });
        expect(updated?.roomSeed).toBeTruthy();
    });

    it("releases the slot when cancelled", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const slot = await createOpenSlot(doctor.doctorId);
        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, slotId: slot.id, appointmentDate: futureDate(), startTime: "10:00", endTime: "11:00", consultationType: "video" });
        const appId = book.body.data.id;

        const cancel = await patient.agent
            .put(`/api/appointments/${appId}/status`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "cancelled" });
        expect(cancel.status).toBe(200);

        const freed = await prisma.consultationSlot.findUnique({ where: { id: slot.id } });
        expect(freed?.isBooked).toBe(false);
    });

    it("reschedules and resets to pending with doctor notification", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const slot = await createOpenSlot(doctor.doctorId);
        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, slotId: slot.id, appointmentDate: futureDate(), startTime: "10:00", endTime: "11:00", consultationType: "video" });
        const appId = book.body.data.id;
        await doctor.agent.put(`/api/appointments/${appId}/status`).set("X-CSRF-Token", doctor.csrf).send({ status: "confirmed" });

        const newSlot = await createOpenSlot(doctor.doctorId, 5, "14:00", "15:00");
        const res = await patient.agent
            .put(`/api/appointments/${appId}/reschedule`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ appointmentDate: futureDate(5), startTime: "14:00", endTime: "15:00", slotId: newSlot.id });
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe("pending");
        expect(res.body.data.startTime).toBe("14:00");
    });

    it("only allows patients to cancel their own pending appointments", async () => {
        const patient = await createUser("patient");
        const other = await createUser("patient");
        const doctor = await createDoctor();
        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, appointmentDate: futureDate(), startTime: "10:00", endTime: "11:00", consultationType: "video" });
        const appId = book.body.data.id;

        const otherCancels = await other.agent
            .put(`/api/appointments/${appId}/status`)
            .set("X-CSRF-Token", other.csrf)
            .send({ status: "cancelled" });
        expect(otherCancels.status).toBe(403);
    });
});
