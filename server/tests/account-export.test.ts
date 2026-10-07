import { describe, it, expect } from "vitest";
import { createUser, createMoodEntry, setupClient } from "./helpers";
import { prisma } from "../src/app";
import { AccountService } from "../src/services/account.service";

/**
 * A data subject access request has to cover everything the deletion covers.
 *
 * This page offers "export my data" and "delete my account" side by side, so the
 * two are read as a pair: export first, delete second. That makes a partial export
 * worse than none - a patient who exports, does not read the file, and deletes
 * loses exactly the parts the export omitted.
 *
 * And it was partial in the way that matters. `deleteAccount` destroys journals,
 * screening answers and safety plans. The export included appointments, moods,
 * pre-session answers, reviews and sent messages - so on this product the
 * screening answers to a PHQ-9 and a patient's own written reasons to live were
 * the things a patient could not take with them.
 *
 * The assertion below is deliberately structural rather than enumerating fields:
 * for each table the deletion empties, the export has to have a key. A test that
 * lists today's omissions goes stale the day somebody adds a model, and a stale
 * test that still passes is worse than no test.
 */
describe("account export covers what account deletion destroys", () => {
    it("exports the journal, the screening answers and the safety plan", async () => {
        const user = await createUser("patient");

        // Seed one row in each of the three that were missing.
        await prisma.journalEntry.create({
            data: { userId: user.id, content: "A private entry", aiSummary: null },
        });
        await prisma.assessment.create({
            data: { userId: user.id, type: "phq9", answersJson: "[0,0,0,0,0,0,0,0,1]", score: 1, severity: "minimal" },
        });
        await prisma.safetyPlan.create({
            data: { userId: user.id, reasonsToLive: "My daughter", warningSigns: null, copingStrategies: null, contacts: null, professionalContact: null, locationToBeSafe: null },
        });
        await createMoodEntry(user.id, 3, new Date());

        const res = await user.agent.get("/api/account/export");

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/application\/json/);
        expect(res.headers["content-disposition"]).toMatch(/attachment/);

        // This endpoint returns the file payload directly rather than the
        // `{ status, data }` envelope every other route in the API uses. That is
        // the right shape for a download and is not changed here; it is noted
        // because it is the reason an early draft of this test read
        // `res.body.data` and got undefined for every field.
        const data = res.body;

        for (const key of [
            "user",
            "appointments",
            "moods",
            "preSession",
            "reviews",
            "messagesSent",
            "journal",
            "assessments",
            "safetyPlan",
            "carePlan",
            "riskAlerts",
        ]) {
            expect(Object.prototype.hasOwnProperty.call(data, key), `export is missing "${key}"`).toBe(true);
        }

        // And the content actually came through, not just the keys.
        expect(data.journal).toHaveLength(1);
        expect(data.journal[0].content).toBe("A private entry");
        expect(data.assessments).toHaveLength(1);
        expect(data.assessments[0].type).toBe("phq9");
        // The answers themselves, not only the score: the score is derived, the
        // answers are the patient's own words about their symptoms.
        expect(JSON.parse(data.assessments[0].answersJson)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1]);
        expect(data.safetyPlan.reasonsToLive).toBe("My daughter");
    });

    it("exports a safety plan key even when none was ever written", async () => {
        // A key that is present only when there is data is a key a client cannot
        // rely on, and `carePlan` is the array case of the same thing.
        const user = await createUser("patient");
        const res = await user.agent.get("/api/account/export");
        expect(res.status).toBe(200);
        expect(res.body.safetyPlan).toBeNull();
        expect(Array.isArray(res.body.journal)).toBe(true);
        expect(Array.isArray(res.body.assessments)).toBe(true);
        expect(Array.isArray(res.body.carePlan)).toBe(true);
        expect(Array.isArray(res.body.riskAlerts)).toBe(true);
    });

    it("includes the mood factor tags and day key, not only the score", async () => {
        // Added alongside the rest, because `factors` is what makes a mood series
        // interpretable and `moodDate` is the day the patient recorded it in their
        // own timezone - neither is reconstructible from `mood` and `createdAt`.
        const user = await createUser("patient");
        await createMoodEntry(user.id, 2, new Date(), { factors: '["sleep","work"]' });

        const res = await user.agent.get("/api/account/export");
        expect(res.status).toBe(200);
        expect(res.body.moods[0].factors).toBe('["sleep","work"]');
        expect(res.body.moods[0].moodDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("excludes another patient's record", async () => {
        const mine = await createUser("patient");
        const stranger = await createUser("patient");
        await prisma.journalEntry.create({ data: { userId: stranger.id, content: "Not yours" } });
        await prisma.journalEntry.create({ data: { userId: mine.id, content: "Mine" } });

        const res = await mine.agent.get("/api/account/export");

        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).toContain("Mine");
        expect(JSON.stringify(res.body)).not.toContain("Not yours");
    });

    it("requires authentication", async () => {
        const { agent, csrf } = await setupClient();
        const withCsrf = await agent.get("/api/account/export").set("X-CSRF-Token", csrf);
        expect(withCsrf.status).toBe(401);
    });
});

describe("account deletion", () => {
    it("destroys the journal, the assessments and the safety plan", async () => {
        // The other direction of the pair. Widening the export must not make
        // deletion lenient by accident, and these are the three the export had to
        // be widened for - so a future change that starts retaining them would
        // change what a patient is told on the privacy page, not just this test.
        const user = await createUser("patient");
        await prisma.journalEntry.create({ data: { userId: user.id, content: "Gone" } });
        await prisma.assessment.create({
            data: { userId: user.id, type: "phq9", answersJson: "[]", score: 0, severity: "minimal" },
        });
        await prisma.safetyPlan.create({ data: { userId: user.id, reasonsToLive: "Gone" } });

        await AccountService.deleteAccount(user.id);

        expect(await prisma.journalEntry.count({ where: { userId: user.id } })).toBe(0);
        expect(await prisma.assessment.count({ where: { userId: user.id } })).toBe(0);
        expect(await prisma.safetyPlan.count({ where: { userId: user.id } })).toBe(0);
    });
});
