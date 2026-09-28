import { describe, it, expect } from "vitest";
import { createUser, createMoodEntry } from "./helpers";
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

    it("treats a repeated log for the same day as an update, not a duplicate", async () => {
        const user = await createUser("patient");
        await user.agent.post("/api/wellness/mood").set("X-CSRF-Token", user.csrf).send({ mood: 2 });
        await user.agent.post("/api/wellness/mood").set("X-CSRF-Token", user.csrf).send({ mood: 5 });

        const rows = await prisma.moodEntry.findMany({ where: { userId: user.id } });
        expect(rows.length).toBe(1);
        expect(rows[0].mood).toBe(5);
    });

    it("calculates a 3-day streak", async () => {
        const user = await createUser("patient");
        for (let i = 0; i < 3; i++) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            date.setHours(12, 0, 0, 0);
            await createMoodEntry(user.id, 3, date);
        }
        const stats = await user.agent.get("/api/wellness/mood/stats");
        expect(stats.body.data.streak).toBe(3);
        expect(stats.body.data.trend).toMatch(/improving|stable|declining/);
    });

    it("keeps the streak alive when today is not logged yet", async () => {
        // A user who logged at 23:50 yesterday has not had a chance to log
        // today. Counting only from "today" reported their streak as 0.
        const user = await createUser("patient");
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(23, 50, 0, 0);
        await createMoodEntry(user.id, 4, yesterday);

        const stats = await user.agent.get("/api/wellness/mood/stats");
        expect(stats.body.data.streak).toBe(1);
    });

    it("breaks the streak when a day is missed", async () => {
        const user = await createUser("patient");
        const today = new Date();
        today.setHours(12, 0, 0, 0);
        await createMoodEntry(user.id, 2, today);
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        threeDaysAgo.setHours(12, 0, 0, 0);
        await createMoodEntry(user.id, 5, threeDaysAgo);

        const stats = await user.agent.get("/api/wellness/mood/stats");
        expect(stats.body.data.streak).toBe(1);
    });

    it("does not report a single positive log as a declining trend", async () => {
        // Regression: the previous arithmetic divided the newest
        // `floor(n/2)` entries by that same `floor(n/2)`, so with one entry the
        // recent average became 0 and a 4/5 day was reported as "declining".
        const user = await createUser("patient");
        await createMoodEntry(user.id, 4, new Date());

        const stats = await user.agent.get("/api/wellness/mood/stats");
        expect(stats.body.data.trend).toBe("stable");
    });

    it("averages over a day window rather than a fixed number of entries", async () => {
        const user = await createUser("patient");
        // Three logs 100 days ago must fall outside a 30-day window.
        for (let i = 0; i < 3; i++) {
            const date = new Date();
            date.setDate(date.getDate() - 100 - i);
            date.setHours(12, 0, 0, 0);
            await createMoodEntry(user.id, 1, date);
        }
        const recent = new Date();
        recent.setHours(12, 0, 0, 0);
        await createMoodEntry(user.id, 5, recent);

        const stats = await user.agent.get("/api/wellness/mood/stats");
        expect(stats.body.data.total).toBe(1);
        expect(stats.body.data.average).toBe(5);
    });

    it("logs moods only for the authenticated user", async () => {
        const userA = await createUser("patient");
        const userB = await createUser("patient");
        await userA.agent.post("/api/wellness/mood").set("X-CSRF-Token", userA.csrf).send({ mood: 5 });

        const history = await userB.agent.get("/api/wellness/mood");
        expect(history.body.data.length).toBe(0);
    });

    it("rejects an unbounded history window", async () => {
        const user = await createUser("patient");
        const res = await user.agent.get("/api/wellness/mood?days=99999999");
        expect(res.status).toBe(400);
    });
});
