import { describe, it, expect } from "vitest";
import { createUser } from "./helpers";
import { prisma } from "../src/app";

describe("Wellness (mood tracking)", () => {
    it("logs moods and computes stats", async () => {
        const user = await createUser("patient");
        const mood = await user.agent
            .post("/api/wellness/mood")
            .set("X-CSRF-Token", user.csrf)
            .send({ mood: 4, notes: "Good day" });
        expect(mood.status).toBe(201);
        expect(mood.body.data.mood).toBe(4);

        const stats = await user.agent.get("/api/wellness/mood/stats");
        expect(stats.status).toBe(200);
        expect(stats.body.data.total).toBe(1);
        expect(stats.body.data.average).toBe(4);
        expect(stats.body.data.streak).toBe(1);
    });

    it("rejects out-of-range moods", async () => {
        const user = await createUser("patient");
        const res = await user.agent
            .post("/api/wellness/mood")
            .set("X-CSRF-Token", user.csrf)
            .send({ mood: 9 });
        expect(res.status).toBe(400);
    });

    it("calculates a 3-day streak", async () => {
        const user = await createUser("patient");
        for (let i = 0; i < 3; i++) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            date.setHours(12, 0, 0, 0);
            await prisma.moodEntry.create({ data: { userId: user.id, mood: 3, createdAt: date } });
        }
        const stats = await user.agent.get("/api/wellness/mood/stats");
        expect(stats.body.data.streak).toBe(3);
        expect(stats.body.data.trend).toMatch(/improving|stable|declining/);
    });

    it("breaks the streak when a day is missed", async () => {
        const user = await createUser("patient");
        const today = new Date();
        today.setHours(12, 0, 0, 0);
        await prisma.moodEntry.create({ data: { userId: user.id, mood: 2, createdAt: today } });
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        twoDaysAgo.setHours(12, 0, 0, 0);
        await prisma.moodEntry.create({ data: { userId: user.id, mood: 5, createdAt: twoDaysAgo } });

        const stats = await user.agent.get("/api/wellness/mood/stats");
        expect(stats.body.data.streak).toBe(1); // yesterday missed
    });

    it("logs moods only for the authenticated user", async () => {
        const userA = await createUser("patient");
        const userB = await createUser("patient");
        await userA.agent.post("/api/wellness/mood").set("X-CSRF-Token", userA.csrf).send({ mood: 5 });

        const history = await userB.agent.get("/api/wellness/mood");
        expect(history.body.data.length).toBe(0);
    });
});
