import { describe, it, expect } from "vitest";
import { prisma } from "../src/app";
import { createUser, createDoctor } from "./helpers";
import { detectFreeTextRisk, CRISIS_PATTERNS } from "../src/services/crisisText.service";

/**
 * Free-text crisis triage.
 *
 * The property under test throughout is that a match is a *prompt for a human*,
 * never an action. The matcher is allowed to be imprecise; what it must never
 * do is act on its own, and it must never take a message down.
 */

describe("detectFreeTextRisk", () => {
    it("matches an English disclosure", () => {
        const result = detectFreeTextRisk("I want to kill myself");
        expect(result?.matched).toBe(true);
        expect(result?.level).toBe("urgent");
        expect(result?.matchedText).toBeTruthy();
    });

    it("matches an Indonesian disclosure", () => {
        // A crisis channel that only works in English is not a crisis channel,
        // and Indonesian is a first-language locale for this product.
        expect(detectFreeTextRisk("saya ingin bunuh diri")).not.toBeNull();
        expect(detectFreeTextRisk("ingin mati")).not.toBeNull();
    });

    it("ignores ordinary conversation", () => {
        expect(detectFreeTextRisk("Thanks for the session yesterday, I feel better")).toBeNull();
        expect(detectFreeTextRisk("Can we move my appointment to Friday?")).toBeNull();
        expect(detectFreeTextRisk("")).toBeNull();
    });

    it("does not page anyone about a disclosure by a third party", () => {
        // A patient describing a relative is not the patient disclosing, and
        // paging a clinician for it trains clinicians to ignore the queue.
        expect(detectFreeTextRisk("My brother said he wanted to end his life")).toBeNull();
        expect(detectFreeTextRisk("my friend is thinking about suicide")).toBeNull();
    });

    it("names the phrase that matched, so a clinician can verify it", () => {
        const result = detectFreeTextRisk("honestly I want to die");
        expect(result?.matchedText.toLowerCase()).toContain("want to die");
    });

    it("describes itself as a keyword match, not a clinical assessment", () => {
        // The reason text is shown to a clinician. Anything that reads like a
        // diagnosis would be the model speaking where it has no standing.
        const result = detectFreeTextRisk("I feel like hurting myself");
        expect(result?.reason).toMatch(/keyword match/i);
        expect(result?.reason).toMatch(/not a clinical assessment/i);
    });

    it("has no stateful lastIndex to leak between calls", () => {
        // A /g regex is stateful: `.test()` advances lastIndex, so the same
        // string alternates true/false across calls. That bug is invisible in a
        // single assertion and would mean roughly half of all disclosures were
        // silently dropped.
        const message = "I want to kill myself";
        for (let i = 0; i < 5; i += 1) {
            expect(detectFreeTextRisk(message)).not.toBeNull();
        }
    });

    it("exposes patterns that are safe to reuse across calls", () => {
        // Guards the same hazard at the source, so adding a /g pattern later
        // fails here rather than as intermittent production misses.
        for (const pattern of CRISIS_PATTERNS) {
            expect(pattern.global).toBeFalsy();
        }
    });
});

describe("crisis triage on a patient-to-clinician message", () => {
    const connect = async (patientId: number, doctorUserId: number) =>
    prisma.appointment.create({
        data: {
            // Both relations connected rather than given as bare scalar ids:
            // Prisma rejects a `data` that mixes the two forms and reports the
            // nested relation as missing.
            user: { connect: { id: patientId } },
            doctor: { connect: { userId: doctorUserId } },
            appointmentDate: new Date(),
            startTime: "10:00",
            endTime: "11:00",
            status: "confirmed",
            consultationType: "chat",
        },
    });

    it("raises a queue item addressed to the treating clinician", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await connect(patient.id, doctor.id);

        const res = await patient.agent
            .post(`/api/messages/${doctor.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ content: "I do not think I can keep going, I want to die" });

        expect(res.status).toBe(201);

        // The raise is deliberately not awaited on the request path, so poll
        // briefly rather than assume it has landed.
        let alert = null;
        for (let i = 0; i < 20 && !alert; i += 1) {
            alert = await prisma.riskAlert.findFirst({
                where: { userId: patient.id, sourceType: "message" },
            });
            if (!alert) await new Promise((r) => setTimeout(r, 50));
        }

        expect(alert).not.toBeNull();
        expect(alert!.level).toBe("urgent");
        expect(alert!.assignedDoctorUserId).toBe(doctor.id);
    });

    it("links the queue item to the message that triggered it", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await connect(patient.id, doctor.id);

        const res = await patient.agent
            .post(`/api/messages/${doctor.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ content: "I have been thinking about ending my life" });
        const messageId = res.body.data.id;

        let alert = null;
        for (let i = 0; i < 20 && !alert; i += 1) {
            alert = await prisma.riskAlert.findFirst({ where: { sourceType: "message" } });
            if (!alert) await new Promise((r) => setTimeout(r, 50));
        }

        // So a clinician opens the exact message rather than guessing which.
        expect(alert?.sourceId).toBe(messageId);
    });

    it("does not queue ordinary messages", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await connect(patient.id, doctor.id);

        await patient.agent
            .post(`/api/messages/${doctor.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ content: "Could we move our session to Thursday?" });

        // Give the fire-and-forget raise a chance to misfire before asserting.
        await new Promise((r) => setTimeout(r, 300));

        const alerts = await prisma.riskAlert.findMany({ where: { sourceType: "message" } });
        expect(alerts).toHaveLength(0);
    });

    it("delivers the message even when it discloses a crisis", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await connect(patient.id, doctor.id);

        const res = await patient.agent
            .post(`/api/messages/${doctor.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ content: "I want to end my life" });

        // Triage must never block, delay or swallow the message. The clinician
        // reads the queue and then reads the message.
        expect(res.status).toBe(201);
        expect(res.body.data.content).toBe("I want to end my life");

        const stored = await prisma.message.findUnique({ where: { id: res.body.data.id } });
        expect(stored?.content).toBe("I want to end my life");
    });

    it("does not queue a clinician's own clinical language", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await connect(patient.id, doctor.id);

        // A clinician writing about self-harm in a message is describing a
        // clinical situation, not disclosing one. The sender's role decides, not
        // the wording, so this cannot be handled by the wording filter alone.
        await doctor.agent
            .post(`/api/messages/${patient.id}`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ content: "We should talk about when you feel like hurting yourself" });

        await new Promise((r) => setTimeout(r, 300));

        const alerts = await prisma.riskAlert.findMany({ where: { sourceType: "message" } });
        expect(alerts).toHaveLength(0);
    });

    it("strips markup from the stored message", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await connect(patient.id, doctor.id);

        const res = await patient.agent
            .post(`/api/messages/${doctor.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ content: "<img src=x onerror=alert(1)> I want to die" });

        const stored = await prisma.message.findUnique({ where: { id: res.body.data.id } });
        // Whatever the triage does, the stored text is inert.
        expect(stored?.content).not.toContain("<img");
    });
});
