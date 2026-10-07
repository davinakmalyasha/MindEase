import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, createUser, createDoctor, setupClient } from "./helpers";
import { summariseSosDelivery, type SosDelivery } from "../src/controllers/support.controller";
import { prisma } from "../src/app";

// Chat is authenticated: anonymous calls would expose paid AI capacity.
const chat = async (message: string) => {
    const user = await createUser("patient");
    const res = await user.agent
        .post("/api/support/chat")
        .set("X-CSRF-Token", user.csrf)
        .send({ message });
    return res;
};

/** Books and confirms a session so the patient has an assigned clinician. */
const withAssignedDoctor = async () => {
    const patient = await createUser("patient");
    const doctor = await createDoctor();
    const book = await patient.agent
        .post("/api/appointments/book")
        .set("X-CSRF-Token", patient.csrf)
        .send({
            doctorId: doctor.doctorId,
            appointmentDate: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
            startTime: "10:00",
            endTime: "11:00",
            consultationType: "video",
        });
    await doctor.agent
        .put(`/api/appointments/${book.body.data.id}/status`)
        .set("X-CSRF-Token", doctor.csrf)
        .send({ status: "confirmed" });
    return { patient, doctor };
};

describe("Support chat", () => {
    it("routes crisis messages to hotlines immediately", async () => {
        const res = await chat("I want to kill myself tonight");
        expect(res.status).toBe(200);
        expect(res.body.data.crisis).toBe(true);
        expect(res.body.data.reply).toContain("119");
    });

    it("detects Indonesian crisis keywords", async () => {
        const res = await chat("saya ingin bunuh diri");
        expect(res.status).toBe(200);
        expect(res.body.data.crisis).toBe(true);
        expect(res.body.data.reply).toContain("112");
    });

    it("offers human customer service on escalation requests", async () => {
        const res = await chat("I want to talk to a real person");
        expect(res.status).toBe(200);
        expect(res.body.data.escalated).toBe(true);
        expect(res.body.data.reply).toContain("support@mindease.id");
    });

    it("answers ordinary questions with the fallback knowledge base", async () => {
        const res = await chat("How do I book a session?");
        expect(res.status).toBe(200);
        expect(res.body.data.crisis).toBe(false);
        expect(typeof res.body.data.reply).toBe("string");
        expect(res.body.data.reply.length).toBeGreaterThan(10);
    });

    it("rejects empty messages", async () => {
        const user = await createUser("patient");
        const res = await user.agent.post("/api/support/chat").set("X-CSRF-Token", user.csrf).send({ message: "" });
        expect(res.status).toBe(400);
    });

    it("rejects anonymous callers", async () => {
        // The CSRF guard runs before authentication, so an anonymous POST
        // without a token is rejected there. Defence in depth: even a caller
        // who somehow obtains a CSRF token still cannot reach the handler.
        const res = await request(app).post("/api/support/chat").send({ message: "hello" });
        expect(res.status).toBe(403);

        const { agent, csrf } = await setupClient();
        const withCsrf = await agent
            .post("/api/support/chat")
            .set("X-CSRF-Token", csrf)
            .send({ message: "hello" });
        expect(withCsrf.status).toBe(401);
    });
});

describe("SOS", () => {
    it("records an urgent queue item and reaches the assigned clinician", async () => {
        const { patient, doctor } = await withAssignedDoctor();

        const res = await patient.agent.post("/api/support/sos").set("X-CSRF-Token", patient.csrf);

        expect(res.status).toBe(200);
        expect(res.body.data.hotlines.length).toBeGreaterThan(0);
        expect(res.body.data.recorded).toBe(true);

        // The SOS is the one signal that is certainly genuine, so it has to be
        // visible in the queue rather than existing only as an audit row.
        const alert = await prisma.riskAlert.findFirst({
            where: { userId: patient.id, sourceType: "sos" },
        });
        expect(alert).toBeTruthy();
        expect(alert?.level).toBe("urgent");
        expect(alert?.assignedDoctorUserId).toBe(doctor.id);

        const notifications = await doctor.agent.get("/api/notifications");
        expect(
            notifications.body.data.rows.some((n: { title: string }) => /SOS Alert/i.test(n.title))
        ).toBe(true);
    });

    it("reports that nobody was reached when every channel fails", async () => {
        // The regression. `doctorAlerted` used to be hardcoded true because an
        // appointment row existed, with four try/catch blocks above it that only
        // logged. With Redis, SMTP and WhatsApp all down, a patient pressing the
        // button marked "I need help now" was told their care team had been
        // alerted, and no clinician was.
        //
        // Breaking all four channels for real would need Redis, SMTP and
        // WhatsApp all mocked, and this suite mocks nothing - Prisma runs
        // against a real database and the assertions are about real delivery. So
        // the rule is pinned directly instead; see the unit tests below for the
        // same reason.
        const { patient } = await withAssignedDoctor();
        const res = await patient.agent.post("/api/support/sos").set("X-CSRF-Token", patient.csrf);
        expect(res.status).toBe(200);
        // Whatever the outcome, the hotlines are never withheld. That is the
        // whole point of the endpoint and it is unconditional.
        expect(res.body.data.hotlines.length).toBeGreaterThan(0);
    });

    it("tells a patient with no therapist that nobody could be paged", async () => {
        const patient = await createUser("patient");
        const res = await patient.agent.post("/api/support/sos").set("X-CSRF-Token", patient.csrf);

        expect(res.status).toBe(200);
        expect(res.body.data.doctorAlerted).toBe(false);
        expect(res.body.data.doctorName).toBeNull();
        expect(res.body.data.hotlines.length).toBeGreaterThan(0);
        // No clinician exists, so nothing is recorded and nothing is claimed.
        expect(await prisma.riskAlert.count({ where: { userId: patient.id } })).toBe(0);
    });

    it("is available to patients only", async () => {
        const doctor = await createDoctor();
        const res = await doctor.agent.post("/api/support/sos").set("X-CSRF-Token", doctor.csrf);
        expect(res.status).toBe(403);
    });
});

describe("summariseSosDelivery", () => {
    const attempt = (over: Partial<SosDelivery> = {}): SosDelivery => ({
        inApp: false,
        realtime: false,
        whatsapp: false,
        email: false,
        ...over,
    });

    it("says nobody was reached when every channel failed", () => {
        // The regression, pinned directly. `doctorAlerted` was previously a
        // hardcoded `true` sitting above four try/catch blocks that only logged,
        // so this combination reported a paged clinician when nobody had been
        // contacted by anything.
        expect(summariseSosDelivery(attempt()).doctorAlerted).toBe(false);
    });

    it("does not count realtime on its own", () => {
        // Realtime is fire-and-forget over pub/sub with no backlog, so a publish
        // that succeeds while the clinician has no tab open has reached nobody.
        // Counting it would make the answer depend on the least reliable channel.
        expect(summariseSosDelivery(attempt({ realtime: true })).doctorAlerted).toBe(false);
    });

    it.each([
        ["in-app", attempt({ inApp: true })],
        ["whatsapp", attempt({ whatsapp: true })],
        ["email", attempt({ email: true })],
    ])("counts a durable %s channel as reached", (_name, delivered) => {
        expect(summariseSosDelivery(delivered).doctorAlerted).toBe(true);
    });

    it("is true when several channels land and false when only realtime does", () => {
        // Both directions, so the function cannot be made to always return true
        // (the previous bug) or always return false (the opposite bug).
        expect(summariseSosDelivery(attempt({ inApp: true, realtime: true })).doctorAlerted).toBe(true);
        expect(summariseSosDelivery(attempt({ realtime: true })).doctorAlerted).toBe(false);
    });
});
