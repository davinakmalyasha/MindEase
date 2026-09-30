import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createUser, createDoctor } from "./helpers";
import { prisma } from "../src/app";
import { __setAIClient, __resetAICircuit, type ModelDouble } from "../src/services/ai.service";

/**
 * Briefing provenance must survive the cache round-trip.
 *
 * A clinical briefing is generated once and re-read later, possibly days later
 * and possibly many times. An origin flag that lived only on the generating
 * HTTP response would be gone by the time anyone actually looked at the text,
 * which is exactly the moment a clinician needs to know whether they are
 * reading a model synthesis or a deterministic platform summary.
 */

const futureDate = (days = 4) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const bookFor = async (patient: any, doctor: any) => {
    const res = await patient.agent
        .post("/api/appointments/book")
        .set("X-CSRF-Token", patient.csrf)
        .send({
            doctorId: doctor.doctorId,
            appointmentDate: futureDate(),
            startTime: "10:00",
            endTime: "11:00",
            consultationType: "video",
        });

    // The briefing is only available once the doctor has confirmed, which is
    // also what makes it a clinical document rather than a pending enquiry.
    await doctor.agent
        .put(`/api/appointments/${res.body.data.id}/status`)
        .set("X-CSRF-Token", doctor.csrf)
        .send({ status: "confirmed" });

    return res;
};

const generate = (doctor: any, appId: number) =>
    doctor.agent
        .post("/api/ai/briefing")
        .set("X-CSRF-Token", doctor.csrf)
        .send({ appointmentId: appId });

const readCached = (doctor: any, appId: number) =>
    doctor.agent.get(`/api/ai/briefing/${appId}`);

describe("briefing provenance persistence", () => {
    beforeEach(() => {
        __resetAICircuit();
    });
    afterEach(() => {
        __setAIClient(null);
        __resetAICircuit();
    });

    it("stores and re-reports a model-written briefing", async () => {
        __setAIClient({
            generateContent: async () => ({
                response: { text: () => "The patient reports low mood and sleep disruption this fortnight." },
            }),
        });

        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        expect(book.status).toBe(201);
        const appId = book.body.data.id;

        const generated = await generate(doctor, appId);
        expect(generated.status).toBe(200);
        expect(generated.body.data.ai.source).toBe("model");

        // The row itself must record the origin, not just the response.
        const row = await prisma.preSessionData.findUnique({ where: { appointmentId: appId } });
        expect(row?.briefingSource).toBe("model");

        // A later read must not lose that.
        const cached = await readCached(doctor, appId);
        expect(cached.status).toBe(200);
        expect(cached.body.data.cached).toBe(true);
        expect(cached.body.data.ai.source).toBe("model");
        expect(cached.body.data.briefing).toContain("sleep disruption");
    });

    it("stores and re-reports a fallback briefing", async () => {
        __setAIClient({
            generateContent: async () => {
                throw new Error("provider down");
            },
        });

        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;

        const generated = await generate(doctor, appId);
        expect(generated.body.data.ai.source).toBe("fallback");

        const row = await prisma.preSessionData.findUnique({ where: { appointmentId: appId } });
        expect(row?.briefingSource).toBe("fallback");

        // This is the case a response-only flag would have silently lost: the
        // clinician reloads the page days later and the origin is still known.
        const cached = await readCached(doctor, appId);
        expect(cached.body.data.ai.source).toBe("fallback");
        expect(cached.body.data.briefing).toContain("Automated summary");
    });

    it("re-derives a fresh briefing after the cached one is invalidated", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;

        // First read with no model available produces a fallback.
        __setAIClient({
            generateContent: async () => {
                throw new Error("provider down");
            },
        });
        await generate(doctor, appId);
        expect(
            (await prisma.preSessionData.findUnique({ where: { appointmentId: appId } }))?.briefingSource
        ).toBe("fallback");

        // The patient submitting answers invalidates the cached briefing, so
        // the next read regenerates. This is the `update` branch of the upsert,
        // which a first-time generate never touches. Questions must exist
        // first — the patient is answering, not writing them from nothing.
        __setAIClient({
            generateContent: async () => ({
                response: {
                    text: () => JSON.stringify(["How have you been?", "How is your sleep?"]),
                },
            }),
        });
        const questions = await patient.agent
            .post("/api/ai/pre-session")
            .set("X-CSRF-Token", patient.csrf)
            .send({ appointmentId: appId });
        expect(questions.status).toBe(200);

        __setAIClient({
            generateContent: async () => ({ response: { text: () => "Regenerated synthesis." } }),
        });
        const submitted = await patient.agent
            .post("/api/ai/pre-session/answers")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                appointmentId: appId,
                answers: [{ question: "How have you been?", answer: "Low, and sleeping badly." }],
            });
        expect(submitted.status).toBe(200);

        const regen = await readCached(doctor, appId);
        expect(regen.status).toBe(200);
        expect(regen.body.data.cached).toBe(false);
        // The stored origin must move with the text, not keep the stale value.
        expect(
            (await prisma.preSessionData.findUnique({ where: { appointmentId: appId } }))?.briefingSource
        ).toBe("model");
        expect(regen.body.data.ai.source).toBe("model");
        expect(regen.body.data.briefing).toBe("Regenerated synthesis.");
    });
});

describe("AI responses carry provenance over HTTP", () => {
    beforeEach(() => __resetAICircuit());
    afterEach(() => {
        __setAIClient(null);
        __resetAICircuit();
    });

    it("reports a degraded wellness suggestion set", async () => {
        __setAIClient({
            generateContent: async () => {
                throw new Error("provider down");
            },
        } satisfies ModelDouble);

        const user = await createUser("patient");
        const res = await user.agent
            .post("/api/ai/resources")
            .set("X-CSRF-Token", user.csrf);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(3);
        expect(res.body.ai.source).toBe("fallback");
        expect(res.body.ai.degradedReason).toBe("error");
    });

    it("replaces the guessed aiPowered flag with a real source on doctor matching", async () => {
        __setAIClient(null); // no key configured at all
        const user = await createUser("patient");
        const res = await user.agent
            .post("/api/ai/match-doctors")
            .set("X-CSRF-Token", user.csrf)
            .send({ query: "anxiety and panic attacks" });

        expect(res.status).toBe(200);
        // Previously this was `!!process.env.GEMINI_API_KEY` — a statement about
        // configuration, not about whether a model was consulted.
        expect(res.body.data.aiPowered).toBeUndefined();
        expect(res.body.data.ai.source).toBe("fallback");
        expect(res.body.data.ai.degradedReason).toBe("not_configured");
    });
});
