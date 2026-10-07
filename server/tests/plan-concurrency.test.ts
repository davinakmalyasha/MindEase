/**
 * Two people editing the same plan document at the same time.
 *
 * Both `CarePlan` and `SafetyPlan` are patient-owned *and* editable by a
 * clinician, which makes concurrent editing the normal case rather than an edge
 * case. Neither had a version column, so the second save silently overwrote the
 * first — and the response said `200`, so nobody was ever told.
 *
 * `care-plan-regressions.test.ts` covers the adjacent data-loss bug: a *partial*
 * save erasing the rest of the document. This is the concurrent case, and the
 * difference matters. That one lost fields within a single save; this one loses
 * an entire editor's work between two saves, and both authors leave thinking
 * they saved.
 *
 * The two properties under test are deliberately different:
 *
 *   - the *sequential* case (read, save, read again, save again with the stale
 *     value) is what a client does after someone else has edited, and must 409;
 *   - the *concurrent* case fires both saves without awaiting, and must still
 *     leave exactly one winner. That is the one a check-then-write
 *     implementation fails and only a conditional `UPDATE` survives.
 */

import { describe, it, expect } from "vitest";
import { prisma } from "../src/app";
import { createUser, createDoctor } from "./helpers";

/** Puts a confirmed appointment in place so the clinician relationship exists. */
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

const planFor = async (patientId: number) =>
    prisma.carePlan.create({ data: { userId: patientId, title: "Original" } });

describe("concurrent care plan edits", () => {
    it("rejects the second save when the version has moved on", async () => {
        const patient = await createUser("patient");
        const plan = await planFor(patient.id);

        const first = await patient.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ version: 0, summary: "What I wrote while you were away." });
        expect(first.status).toBe(200);

        // Same stale version 0, now wrong.
        const second = await patient.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ version: 0, summary: "What I wrote without seeing theirs." });
        expect(second.status).toBe(409);

        // And the loser's text was not written. This is the assertion that
        // matters - a 409 is only worth having if the write really did not happen.
        const stored = await prisma.carePlan.findUniqueOrThrow({ where: { id: plan.id } });
        expect(stored.summary).toBe("What I wrote while you were away.");
    });

    it("accepts a save carrying the current version", async () => {
        const patient = await createUser("patient");
        const plan = await planFor(patient.id);

        const first = await patient.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ version: 0, summary: "one" });
        expect(first.status).toBe(200);
        expect(first.body.data.version).toBe(1);

        const second = await patient.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ version: 1, summary: "two" });
        expect(second.status).toBe(200);
        expect(second.body.data.version).toBe(2);
    });

    it("lets exactly one of two simultaneous saves win", async () => {
        // The check-then-write version of this: read version 0, then update by
        // `id` alone. Both writes match and one silently disappears. Only a
        // conditional UPDATE gives one row a single winner.
        const patient = await createUser("patient");
        const plan = await planFor(patient.id);

        const [a, b] = await Promise.all([
            patient.agent
                .put(`/api/care-plan/${plan.id}`)
                .set("X-CSRF-Token", patient.csrf)
                .send({ version: 0, summary: "editor A" }),
            patient.agent
                .put(`/api/care-plan/${plan.id}`)
                .set("X-CSRF-Token", patient.csrf)
                .send({ version: 0, summary: "editor B" }),
        ]);

        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([200, 409]);

        const stored = await prisma.carePlan.findUniqueOrThrow({ where: { id: plan.id } });
        // Exactly one writer's text, and the version advanced exactly once.
        expect(["editor A", "editor B"]).toContain(stored.summary);
        expect(stored.version).toBe(1);
    });

    it("requires a version, so an un-updated client fails loudly", async () => {
        // The alternative to a required version is optional - which means a
        // client that was never updated keeps writing and keeps overwriting,
        // silently. A 400 names the client that needs fixing.
        const patient = await createUser("patient");
        const plan = await planFor(patient.id);

        const res = await patient.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ summary: "no version sent" });

        expect(res.status).toBe(400);
        const stored = await prisma.carePlan.findUniqueOrThrow({ where: { id: plan.id } });
        expect(stored.version).toBe(0);
    });

    it("does not let a clinician's goal bump the plan's version", async () => {
        // Goals are a separate endpoint with a separate schema. If adding a goal
        // moved the plan version, a patient holding an open editor would get a
        // spurious 409 for a document they did not conflict over.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        const plan = await planFor(patient.id);

        await doctor.agent
            .post(`/api/care-plan/${plan.id}/goals`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ title: "Journal every evening" });

        const stored = await prisma.carePlan.findUniqueOrThrow({ where: { id: plan.id } });
        expect(stored.version).toBe(0);
    });
});

describe("concurrent safety plan edits", () => {
    it("rejects a stale save and keeps the winner's text", async () => {
        const patient = await createUser("patient");

        const first = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ reasonsToLive: "My sister" });
        expect(first.status).toBe(200);
        expect(first.body.data.version).toBe(0);

        const second = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ version: 0, reasonsToLive: "My daughter" });
        expect(second.status).toBe(200);
        expect(second.body.data.version).toBe(1);

        const stale = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ version: 0, reasonsToLive: "Written from a stale screen" });
        expect(stale.status).toBe(409);

        const stored = await prisma.safetyPlan.findUniqueOrThrow({ where: { userId: patient.id } });
        expect(stored.reasonsToLive).toBe("My daughter");
    });

    it("treats a first save as a create, not a conflict", async () => {
        // No row exists, so there is nothing to be stale about. A 409 here would
        // make the very first save impossible.
        const patient = await createUser("patient");

        const res = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ warningSigns: "Not sleeping." });

        expect(res.status).toBe(200);
        expect(res.body.data.version).toBe(0);
    });

    it("lets exactly one of two simultaneous safety plan saves win", async () => {
        const patient = await createUser("patient");
        await prisma.safetyPlan.create({ data: { userId: patient.id, reasonsToLive: "start" } });

        const [a, b] = await Promise.all([
            patient.agent
                .put("/api/safety-plan")
                .set("X-CSRF-Token", patient.csrf)
                .send({ version: 0, reasonsToLive: "editor A" }),
            patient.agent
                .put("/api/safety-plan")
                .set("X-CSRF-Token", patient.csrf)
                .send({ version: 0, reasonsToLive: "editor B" }),
        ]);

        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([200, 409]);

        const stored = await prisma.safetyPlan.findUniqueOrThrow({ where: { userId: patient.id } });
        expect(["editor A", "editor B"]).toContain(stored.reasonsToLive);
        expect(stored.version).toBe(1);
    });

    it("keeps a partial save from erasing the sections it did not mention", async () => {
        // The original regression, re-asserted: the concurrency change replaced
        // an `upsert` with a `create`/`updateMany` pair, and that is exactly the
        // kind of rewrite that silently drops the "only the keys the caller sent"
        // behaviour the merge depended on.
        const patient = await createUser("patient");

        await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                warningSigns: "Spiralling thoughts at night",
                copingStrategies: "Walking",
                reasonsToLive: "My sister",
                professionalContact: "Dr Rao, 555-0101",
            });

        const res = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ version: 0, professionalContact: "Crisis line, 1199" });

        expect(res.status).toBe(200);
        const stored = await prisma.safetyPlan.findUniqueOrThrow({ where: { userId: patient.id } });
        expect(stored.professionalContact).toBe("Crisis line, 1199");
        // Everything not mentioned survived.
        expect(stored.warningSigns).toBe("Spiralling thoughts at night");
        expect(stored.copingStrategies).toBe("Walking");
        expect(stored.reasonsToLive).toBe("My sister");
    });
});
