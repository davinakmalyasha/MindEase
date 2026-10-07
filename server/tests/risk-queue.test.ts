import { describe, it, expect } from "vitest";
import { prisma } from "../src/app";
import { createUser, createDoctor, createAdmin } from "./helpers";
import { priorityFor } from "../src/services/riskQueue.service";

/**
 * The clinician triage queue.
 *
 * Every case here is about a disclosure of thoughts of self-harm reaching the
 * right human, so the assertions are deliberately about *who can see what* and
 * *what state an alert is left in* rather than about payload shape.
 */

const raiseAlert = async (opts: {
    userId: number;
    level?: string;
    sourceType?: string;
    assignedDoctorUserId?: number | null;
    acknowledgedAt?: Date | null;
    resolvedAt?: Date | null;
}) =>
    prisma.riskAlert.create({
        data: {
            userId: opts.userId,
            level: opts.level ?? "urgent",
            reason: "PHQ-9 item 9 answered \"several days\".",
            sourceType: opts.sourceType ?? "phq9",
            assignedDoctorUserId: opts.assignedDoctorUserId ?? null,
            acknowledgedAt: opts.acknowledgedAt ?? null,
            resolvedAt: opts.resolvedAt ?? null,
        },
    });

/** Puts a confirmed appointment in place so the clinical relationship exists. */
const confirmAppointment = async (patientId: number, doctorUserId: number) =>
    prisma.appointment.create({
        data: {
            // Both relations are connected rather than given as a bare scalar
            // id. Prisma rejects a `data` that mixes the two forms: passing
            // `userId` alongside `doctor: { connect }` makes the write
            // ambiguous and it throws "Argument `user` is missing".
            user: { connect: { id: patientId } },
            doctor: { connect: { userId: doctorUserId } },
            appointmentDate: new Date(),
            startTime: "10:00",
            endTime: "11:00",
            status: "confirmed",
            consultationType: "video",
        },
    });

describe("risk queue priority", () => {
    it("ranks urgent above elevated", () => {
        expect(priorityFor("urgent", null)).toBeLessThan(priorityFor("elevated", null));
    });

    it("ranks unacknowledged above acknowledged within a level", () => {
        expect(priorityFor("urgent", null)).toBeLessThan(priorityFor("urgent", new Date()));
        expect(priorityFor("elevated", null)).toBeLessThan(priorityFor("elevated", new Date()));
    });

    it("keeps an acknowledged urgent above an unacknowledged elevated", () => {
        // Acknowledging is not resolving. Burying a still-urgent disclosure
        // under a routine one because someone glanced at it is the exact
        // failure the ordering exists to prevent.
        expect(priorityFor("urgent", new Date())).toBeLessThan(
            priorityFor("elevated", null)
        );
    });

    it("falls back rather than throwing on an unknown level", () => {
        // `level` is a free string column, so an unexpected value is a database
        // reality, not a theoretical one. It must not crash the queue.
        expect(() => priorityFor("catastrophic", null)).not.toThrow();
        expect(priorityFor("catastrophic", null)).toBeGreaterThanOrEqual(0);
    });
});

describe("GET /api/wellness/risk-alerts", () => {
    it("shows a clinician the alerts for their own patients", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });

        const res = await doctor.agent.get("/api/wellness/risk-alerts");

        expect(res.status).toBe(200);
        expect(res.body.data.map((a: { id: number }) => a.id)).toContain(alert.id);
    });

    it("does not show a clinician another clinician's patients", async () => {
        const patient = await createUser("patient");
        const treating = await createDoctor();
        const stranger = await createDoctor();
        await confirmAppointment(patient.id, treating.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: treating.id });

        const res = await stranger.agent.get("/api/wellness/risk-alerts");

        expect(res.status).toBe(200);
        expect(res.body.data.map((a: { id: number }) => a.id)).not.toContain(alert.id);
    });

    it("keeps an alert visible after the clinical relationship has lapsed", async () => {
        // The regression this file exists for. The list query used to AND the
        // relationship filter with the assignment filter, so an alert assigned to
        // a clinician disappeared the moment the appointment that created the
        // relationship stopped being confirmed or completed - while
        // `assertCanTriage` still let them acknowledge and resolve it by id. An
        // open disclosure, invisible in the queue and in the nav badge, but
        // still actionable. Silent loss on a triage queue.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });

        // The relationship lapses. Not deleted - cancelled, which is what a
        // patient cancelling actually does.
        await prisma.appointment.updateMany({
            where: { user: { id: patient.id }, doctor: { userId: doctor.id } },
            data: { status: "cancelled" },
        });

        const res = await doctor.agent.get("/api/wellness/risk-alerts");

        expect(res.status).toBe(200);
        expect(res.body.data.map((a: { id: number }) => a.id)).toContain(alert.id);
        // And it still counts, so the badge tells the clinician there is work.
        expect(res.body.counts.unresolved).toBe(1);
        expect(res.body.counts.urgentUnacknowledged).toBe(1);
    });

    it("still hides an unassigned alert once the relationship has lapsed", async () => {
        // The other half of the fix. Assignment is what survives a lapsed
        // relationship; without it, "visible to the clinician who treats you"
        // still has to hold, or the queue leaks a patient's disclosure to a
        // clinician who no longer has any relationship with them.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: null });

        await prisma.appointment.updateMany({
            where: { user: { id: patient.id }, doctor: { userId: doctor.id } },
            data: { status: "cancelled" },
        });

        const res = await doctor.agent.get("/api/wellness/risk-alerts");

        expect(res.status).toBe(200);
        expect(res.body.data.map((a: { id: number }) => a.id)).not.toContain(alert.id);
    });

    it("records one acknowledger when two clinicians click at the same moment", async () => {
        // `acknowledge` read the alert, checked `acknowledgedAt` was null, then
        // wrote unconditionally. Two clinicians acknowledging the same disclosure
        // together both passed the check and both wrote, so the row named
        // whichever wrote last while the audit log carried two entries by
        // different people - a trail and a record that disagree about who saw a
        // crisis disclosure.
        const patient = await createUser("patient");
        const a = await createDoctor();
        const b = await createDoctor();
        // Both must have a live clinical relationship, or this is testing the
        // authorisation check instead of the race.
        await confirmAppointment(patient.id, a.id);
        await confirmAppointment(patient.id, b.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: a.id });

        const [first, second] = await Promise.all([
            a.agent.post(`/api/wellness/risk-alerts/${alert.id}/acknowledge`).set("X-CSRF-Token", a.csrf),
            b.agent.post(`/api/wellness/risk-alerts/${alert.id}/acknowledge`).set("X-CSRF-Token", b.csrf),
        ]);

        const statuses = [first.status, second.status].sort();
        expect(statuses, `got ${first.status} and ${second.status}`).toEqual([200, 400]);

        // Exactly one audit entry, and it names the clinician the row names.
        const entries = await prisma.auditLog.findMany({
            where: { action: "risk.acknowledged", targetId: alert.id },
        });
        expect(entries, "two acknowledgements were recorded for one acknowledgement").toHaveLength(1);

        const stored = await prisma.riskAlert.findUniqueOrThrow({ where: { id: alert.id } });
        expect(stored.acknowledgedById).toBe(entries[0].actorId);
    });

    it("keeps an alert visible after it is acknowledged", async () => {
        // The previous default filtered on acknowledgedAt: null, so clicking
        // acknowledge made the alert disappear from the list. Acknowledging is
        // "seen", not "done".
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });

        const ack = await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/acknowledge`)
            .set("X-CSRF-Token", doctor.csrf);
        expect(ack.status).toBe(200);

        const res = await doctor.agent.get("/api/wellness/risk-alerts");
        const row = res.body.data.find((a: { id: number }) => a.id === alert.id);
        expect(row).toBeDefined();
        expect(row.acknowledgedAt).toBeTruthy();
    });

    it("hides a resolved alert unless asked for it", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });

        const res = await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/resolve`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ note: "Called and agreed a safety plan." });
        expect(res.status).toBe(200);

        const hidden = await doctor.agent.get("/api/wellness/risk-alerts");
        expect(hidden.body.data.map((a: { id: number }) => a.id)).not.toContain(alert.id);

        const shown = await doctor.agent.get("/api/wellness/risk-alerts?includeResolved=true");
        expect(shown.body.data.map((a: { id: number }) => a.id)).toContain(alert.id);
    });

    it("orders the queue urgent-first, newest first within a level", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);

        const older = await raiseAlert({
            userId: patient.id,
            level: "urgent",
            assignedDoctorUserId: doctor.id,
        });
        await prisma.riskAlert.update({
            where: { id: older.id },
            data: { createdAt: new Date(Date.now() - 60_000) },
        });
        await raiseAlert({ userId: patient.id, level: "elevated", assignedDoctorUserId: doctor.id });

        const res = await doctor.agent.get("/api/wellness/risk-alerts");
        const levels = res.body.data.map((a: { level: string }) => a.level);

        expect(levels[0]).toBe("urgent");
        expect(res.body.data[0].priority).toBeLessThan(res.body.data[1].priority);
    });

    it("returns counts that match the list it is showing", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        await raiseAlert({ userId: patient.id, level: "urgent", assignedDoctorUserId: doctor.id });
        await raiseAlert({ userId: patient.id, level: "elevated", assignedDoctorUserId: doctor.id });

        const res = await doctor.agent.get("/api/wellness/risk-alerts");

        expect(res.body.counts.unresolved).toBe(res.body.data.length);
        expect(res.body.counts.urgentUnacknowledged).toBe(1);
    });

    it("carries the patient's latest screening score so triage needs one request", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });
        await prisma.assessment.create({
            data: { userId: patient.id, type: "phq9", answersJson: "[]", score: 18, severity: "moderately-severe" },
        });

        const res = await doctor.agent.get("/api/wellness/risk-alerts");

        expect(res.body.data[0].patient.lastAssessment.score).toBe(18);
        expect(res.body.data[0].patient.lastAssessment.type).toBe("phq9");
    });

    it("lets an admin see every alert", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });
        const admin = await createAdmin();

        const res = await admin.agent.get("/api/wellness/risk-alerts");

        expect(res.status).toBe(200);
        expect(res.body.data.map((a: { id: number }) => a.id)).toContain(alert.id);
    });

    it("rejects a patient", async () => {
        const patient = await createUser("patient");
        const res = await patient.agent.get("/api/wellness/risk-alerts");
        expect(res.status).toBe(403);
    });
});

describe("POST /api/wellness/risk-alerts/:id/acknowledge", () => {
    it("records who acknowledged and when", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });

        const res = await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/acknowledge`)
            .set("X-CSRF-Token", doctor.csrf);

        expect(res.status).toBe(200);
        expect(res.body.data.acknowledgedById).toBe(doctor.id);

        const stored = await prisma.riskAlert.findUnique({ where: { id: alert.id } });
        expect(stored?.acknowledgedById).toBe(doctor.id);
    });

    it("refuses a second acknowledge rather than silently overwriting", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });

        await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/acknowledge`)
            .set("X-CSRF-Token", doctor.csrf);
        const second = await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/acknowledge`)
            .set("X-CSRF-Token", doctor.csrf);

        expect(second.status).toBe(400);
    });

    it("refuses a clinician with no relationship to the patient", async () => {
        const patient = await createUser("patient");
        const stranger = await createDoctor();
        const alert = await raiseAlert({ userId: patient.id });

        const res = await stranger.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/acknowledge`)
            .set("X-CSRF-Token", stranger.csrf);

        expect(res.status).toBe(403);
    });

    it("404s an alert that does not exist", async () => {
        const doctor = await createDoctor();
        const res = await doctor.agent
            .post("/api/wellness/risk-alerts/99999999/acknowledge")
            .set("X-CSRF-Token", doctor.csrf);
        expect(res.status).toBe(404);
    });
});

describe("POST /api/wellness/risk-alerts/:id/resolve", () => {
    it("records the note and the actor", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });

        const res = await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/resolve`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ note: "Spoke by phone; agreed to see them Thursday." });

        expect(res.status).toBe(200);

        const stored = await prisma.riskAlert.findUnique({ where: { id: alert.id } });
        expect(stored?.resolvedById).toBe(doctor.id);
        expect(stored?.resolutionNote).toBe("Spoke by phone; agreed to see them Thursday.");
    });

    it("implies acknowledgement rather than allowing a silent close", async () => {
        // Closing something you never opened leaves a gap in the audit trail:
        // the reviewer cannot tell who actually looked at the disclosure.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });

        await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/resolve`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ note: "Handled." });

        const stored = await prisma.riskAlert.findUnique({ where: { id: alert.id } });
        expect(stored?.acknowledgedAt).not.toBeNull();
        expect(stored?.acknowledgedById).toBe(doctor.id);
    });

    it("refuses to resolve twice", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });

        await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/resolve`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({});
        const second = await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/resolve`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({});

        expect(second.status).toBe(400);
    });

    it("keeps the row so the disclosure stays on the record", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });

        await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/resolve`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ note: "Resolved." });

        // Deleting would erase the fact that a disclosure happened at all.
        const stored = await prisma.riskAlert.findUnique({ where: { id: alert.id } });
        expect(stored).not.toBeNull();
        expect(stored?.reason).toContain("PHQ-9");
    });

    it("writes an audit entry naming the actor and the note", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });

        await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/resolve`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ note: "Tele-reviewed." });

        const entry = await prisma.auditLog.findFirst({
            where: { action: "risk.resolved", targetId: alert.id },
        });
        expect(entry?.actorId).toBe(doctor.id);
        expect(entry?.meta).toContain("Tele-reviewed.");
    });

    it("rejects an over-long note", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const alert = await raiseAlert({ userId: patient.id, assignedDoctorUserId: doctor.id });

        const res = await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/resolve`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ note: "x".repeat(2000) });

        expect(res.status).toBe(400);
    });
});
