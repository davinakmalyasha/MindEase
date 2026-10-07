/**
 * Reads of clinical records must leave a trace.
 *
 * `AuditLog` recorded writes and admin actions. Nothing recorded a clinician
 * *opening* a disclosure, a briefing, a message thread or a care plan - so the
 * question an access log exists to answer, "who looked at this patient's mental
 * health data and when", could not be answered at all. The absence was
 * invisible precisely because the write side was always covered.
 *
 * These tests pin the properties that make such a log usable, which are not the
 * same as the properties that make it present:
 *
 *   - it records the reader and the patient as *separate* fields, because you
 *     cannot answer either question with one id;
 *   - a patient's access to their own record is not logged, because a log that
 *     fires on self-service is a log people stop reading;
 *   - a failed audit write does not deny the read. The failure mode of an access
 *     log must be "a gap in the record", never "a patient does not get help".
 */

import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma";
import { AuditService } from "../src/services/audit.service";
import { createUser, createDoctor, createAdmin } from "./helpers";

/** Puts a confirmed appointment in place so the clinical relationship exists. */
const confirmAppointment = async (patientId: number, doctorUserId: number) =>
    prisma.appointment.create({
        data: {
            user: { connect: { id: patientId } },
            doctor: { connect: { userId: doctorUserId } },
            appointmentDate: new Date(),
            startTime: "10:00",
            endTime: "11:00",
            status: "confirmed",
            consultationType: "video",
        },
    });

const readsFor = (subjectId: number) => AuditService.readsForSubject(subjectId);

describe("clinical read audit", () => {
    it("records who read a patient's record, and which patient", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);

        await prisma.riskAlert.create({
            data: {
                userId: patient.id,
                assignedDoctorUserId: doctor.id,
                level: "elevated",
                reason: "PHQ-9 item 9",
                sourceType: "phq9",
            },
        });

        const res = await doctor.agent.get("/api/wellness/risk-alerts");
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBeGreaterThan(0);

        const reads = await readsFor(patient.id);
        expect(reads.length).toBe(1);

        // The reader and the subject are separate facts, and both are present.
        expect(reads[0].actorId).toBe(doctor.id);
        expect(reads[0].targetType).toBe("RiskAlert");
        expect(reads[0].action).toBe("clinical.read");
        const meta = JSON.parse(reads[0].meta!);
        expect(meta.subjectId).toBe(patient.id);
    });

    it("records one entry per disclosure, not one per request", async () => {
        // A request that returns three alerts discloses three disclosures. A
        // single entry naming three patients answers neither "who saw patient X"
        // nor "what did clinician Y look at".
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);

        await prisma.riskAlert.create({
            data: {
                userId: patient.id,
                assignedDoctorUserId: doctor.id,
                level: "elevated",
                reason: "one",
                sourceType: "sos",
            },
        });
        await prisma.riskAlert.create({
            data: {
                userId: patient.id,
                assignedDoctorUserId: doctor.id,
                level: "urgent",
                reason: "two",
                sourceType: "message",
            },
        });

        await doctor.agent.get("/api/wellness/risk-alerts");

        const reads = await readsFor(patient.id);
        expect(reads.length).toBe(2);
        // Distinct rows, so the target ids are distinguishable.
        expect(new Set(reads.map((r) => r.targetId)).size).toBe(2);
    });

    it("records a clinician reading a briefing, and says whether it was cached", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const appt = await confirmAppointment(patient.id, doctor.id);

        await prisma.preSessionData.create({
            data: { appointmentId: appt.id, briefingText: "Summary of the last fortnight." },
        });

        const res = await doctor.agent.get(`/api/ai/briefing/${appt.id}`);
        expect(res.status).toBe(200);
        expect(res.body.data.cached).toBe(true);

        const reads = await readsFor(patient.id);
        const briefing = reads.find((r) => r.targetType === "Briefing");
        expect(briefing).toBeDefined();
        expect(briefing!.actorId).toBe(doctor.id);
        expect(JSON.parse(briefing!.meta!).cached).toBe(true);
    });

    it("does not record a patient reading their own safety plan", async () => {
        // Self-service is not an access event. Logging it would fill the trail
        // with entries that mean "this person opened their own file", which is
        // the noise that makes people stop reading access logs.
        const patient = await createUser("patient");

        const res = await patient.agent.get("/api/safety-plan");
        expect(res.status).toBe(200);

        const reads = await readsFor(patient.id);
        expect(reads.filter((r) => r.targetType === "SafetyPlan")).toHaveLength(0);
    });

    it("records a clinician reading a patient's safety plan", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        await prisma.safetyPlan.create({
            data: { userId: patient.id, reasonsToLive: "My sister" },
        });

        const res = await doctor.agent.get(`/api/safety-plan/patient/${patient.id}`);
        expect(res.status).toBe(200);

        const reads = await readsFor(patient.id);
        const plan = reads.find((r) => r.targetType === "SafetyPlan");
        expect(plan).toBeDefined();
        expect(plan!.actorId).toBe(doctor.id);
    });

    it("records a clinician opening a message thread, against the other party", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        await prisma.message.create({
            data: { senderId: patient.id, receiverId: doctor.id, content: "I have not slept." },
        });

        const res = await doctor.agent.get(`/api/messages/${patient.id}/messages`);
        expect(res.status).toBe(200);

        // The subject is the *patient*, and the actor is the clinician - the
        // read discloses the patient's words.
        const reads = await readsFor(patient.id);
        const thread = reads.find((r) => r.targetType === "Message");
        expect(thread).toBeDefined();
        expect(thread!.actorId).toBe(doctor.id);
    });

    it("records a bulk admin export as an event", async () => {
        // Placed here rather than in an admin suite because it is the same
        // question: who has seen patient data. An export is one event over a
        // population, so it is recorded once - with the dataset and the row
        // count - rather than once per patient on it, which would be write
        // amplification and would produce a trail nobody can read.
        const admin = await createAdmin();
        await createUser("patient");

        const res = await admin.agent.get("/api/admin/export/users");
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("text/csv");

        const entry = await prisma.auditLog.findFirst({
            where: { action: "admin.export" },
            orderBy: { id: "desc" },
        });
        expect(entry).not.toBeNull();
        expect(entry!.actorId).toBe(admin.id);
        const meta = JSON.parse(entry!.meta!);
        expect(meta.kind).toBe("users");
        expect(meta.rows).toBeGreaterThan(0);
    });

    it("does not let a failing audit write deny the read", async () => {
        // The whole point of swallowing the audit error: a logging failure must
        // not become a clinician being unable to open a crisis disclosure.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        await prisma.riskAlert.create({
            data: {
                userId: patient.id,
                assignedDoctorUserId: doctor.id,
                level: "urgent",
                reason: "sos",
                sourceType: "sos",
            },
        });

        const original = prisma.auditLog.create.bind(prisma.auditLog);
        // @ts-expect-error - deliberately replacing a client method for one test
        prisma.auditLog.create = async () => {
            throw new Error("audit table unavailable");
        };
        try {
            const res = await doctor.agent.get("/api/wellness/risk-alerts");
            expect(res.status).toBe(200);
            expect(res.body.data.length).toBeGreaterThan(0);
        } finally {
            // @ts-expect-error - restoring
            prisma.auditLog.create = original;
        }

        // And the gap is real: nothing was recorded, which is the documented cost.
        const reads = await readsFor(patient.id);
        expect(reads).toHaveLength(0);
    });
});
