import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, createUser, setupClient } from "./helpers";

// Chat is authenticated: anonymous calls would expose paid AI capacity.
const chat = async (message: string) => {
    const user = await createUser("patient");
    const res = await user.agent
        .post("/api/support/chat")
        .set("X-CSRF-Token", user.csrf)
        .send({ message });
    return res;
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
