import { describe, it, expect } from "vitest";
import request from "supertest";
import { prisma } from "../src/app";
import { createUser, createDoctor } from "./helpers";

/**
 * Regressions for three data-integrity bugs in the care plan and safety plan,
 * all of which were live and none of which had a test.
 *
 * These are not "assert the feature works" tests - the feature worked. Each one
 * here corresponds to a specific way it silently did the wrong thing to a
 * document a person relies on.
 */

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

const saveSafetyPlan = async (
    agent: { agent: request.SuperTest<request.Test>; csrf: string },
    body: Record<string, unknown>
) =>
    agent.agent
        .put("/api/safety-plan")
        .set("X-CSRF-Token", agent.csrf)
        .send(body);

describe("safety plan: a partial save must not erase the rest", () => {
    it("leaves untouched sections alone", async () => {
        // The bug: `save` mapped every field through `input.X ? sanitize(...) :
        // null` and used that as the upsert's `update` branch. Every field in the
        // schema is optional, so a client that sent one section sent the other
        // five as `null` and the update wrote `null` over them.
        //
        // Editing a professional contact erased the warning signs, the coping
        // strategies and the reasons to live. That is data loss on the document a
        // person may need at their worst moment, and the schema made it the
        // natural thing for any single-section form to trigger.
        const patient = await createUser("patient");

        const first = await saveSafetyPlan(patient, {
            warningSigns: "I withdraw and stop replying.",
            copingStrategies: "Walk. Call my sister.",
            reasonsToLive: "My daughter turns six in June.",
            professionalContact: "Dr Asha, +62 811 2222 3333",
        });
        expect(first.status).toBe(200);
        expect(first.body.data.warningSigns).toContain("withdraw");
        expect(first.body.data.reasonsToLive).toContain("daughter");

        // Now edit exactly one section, as a partial form would.
        const second = await saveSafetyPlan(patient, {
            professionalContact: "Dr Asha, +62 811 9999 0000",
        });
        expect(second.status).toBe(200);

        const stored = await prisma.safetyPlan.findUnique({ where: { userId: patient.id } });
        expect(stored?.professionalContact).toContain("9999");
        // The four sections that were not mentioned must survive verbatim.
        expect(stored?.warningSigns).toContain("withdraw");
        expect(stored?.copingStrategies).toContain("sister");
        expect(stored?.reasonsToLive).toContain("daughter");
    });

    it("still lets a section be cleared explicitly", async () => {
        // The counterpart to the test above, and the reason the fix is a merge
        // rather than a blanket "never overwrite". "I have no contact here" is a
        // real edit and has to be expressible.
        const patient = await createUser("patient");
        await saveSafetyPlan(patient, {
            warningSigns: "Something to watch.",
            professionalContact: "Dr Asha",
        });

        const res = await saveSafetyPlan(patient, { professionalContact: "" });
        expect(res.status).toBe(200);

        const stored = await prisma.safetyPlan.findUnique({ where: { userId: patient.id } });
        expect(stored?.professionalContact).toBeNull();
        expect(stored?.warningSigns).toContain("watch");
    });

    it("does not create a second row across partial saves", async () => {
        // The `@unique` on `userId` is the only thing standing between a partial
        // save and a duplicate document, and the upsert is what relies on it.
        const patient = await createUser("patient");
        await saveSafetyPlan(patient, { warningSigns: "One." });
        await saveSafetyPlan(patient, { copingStrategies: "Two." });
        await saveSafetyPlan(patient, { reasonsToLive: "Three." });

        const rows = await prisma.safetyPlan.findMany({ where: { userId: patient.id } });
        expect(rows.length).toBe(1);
    });
});

describe("care plan: calendar dates", () => {
    it("rejects a date that does not exist rather than 500ing on it", async () => {
        // `dateOrNull` was a shape regex only. "2026-13-45" matched, `new
        // Date()` produced an Invalid Date, Prisma threw, and a client error was
        // answered with a 500.
        const patient = await createUser("patient");
        const plan = await prisma.carePlan.create({ data: { userId: patient.id } });

        const res = await patient.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ reviewAt: "2026-13-45" });

        expect(res.status).toBe(400);
    });

    it("rejects a date that rolls forward instead of storing the wrong day", async () => {
        // The quieter half of the same bug. "2026-02-31" matched the regex, and
        // JavaScript rolled it to 3 March - so a review date was silently stored
        // two days late on a document a clinician works from.
        const patient = await createUser("patient");
        const plan = await prisma.carePlan.create({ data: { userId: patient.id } });

        const res = await patient.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ reviewAt: "2026-02-31" });

        expect(res.status).toBe(400);
        const stored = await prisma.carePlan.findUnique({ where: { id: plan.id } });
        expect(stored?.reviewAt).toBeNull();
    });

    it("still accepts a real date", async () => {
        const patient = await createUser("patient");
        const plan = await prisma.carePlan.create({ data: { userId: patient.id } });

        const res = await patient.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ reviewAt: "2026-02-28" });

        expect(res.status).toBe(200);
        const stored = await prisma.carePlan.findUnique({ where: { id: plan.id } });
        expect(stored?.reviewAt).not.toBeNull();
    });
});

describe("care plan: the clinician read that was missing", () => {
    it("lets a treating clinician read the plan they can write into", async () => {
        // The gap: `assertMayContribute` deliberately lets a treating clinician
        // add goals and steps to a patient's plan, but there was no `GET` that
        // let them read it. A clinician could write into a document they had no
        // way to see.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await confirmAppointment(patient.id, doctor.id);
        await prisma.carePlan.create({
            data: { userId: patient.id, title: "Agreed in session" },
        });

        const res = await doctor.agent.get(`/api/care-plan/patient/${patient.id}`);

        expect(res.status).toBe(200);
        expect(res.body.data.length).toBeGreaterThan(0);
        expect(res.body.data[0].title).toBe("Agreed in session");
    });

    it("refuses a clinician with no clinical relationship", async () => {
        const patient = await createUser("patient");
        const stranger = await createDoctor();
        await prisma.carePlan.create({ data: { userId: patient.id } });

        const res = await stranger.agent.get(`/api/care-plan/patient/${patient.id}`);

        expect(res.status).toBe(403);
    });

    it("refuses a patient asking for somebody else's plan", async () => {
        const patient = await createUser("patient");
        const other = await createUser("patient");
        await prisma.carePlan.create({ data: { userId: other.id } });

        const res = await patient.agent.get(`/api/care-plan/patient/${other.id}`);

        // `requireDoctor` is the first gate, so a patient is refused by role
        // before the ownership question is even reached.
        expect(res.status).toBe(403);
    });
});
