import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createUser, createDoctor, createMoodEntry } from "./helpers";
import { prisma } from "../src/app";
import { runCareCheckins } from "../src/jobs/checkins";

/**
 * The mood-decline rule, and the escalation it now performs.
 *
 * The rule is "the last three mood logs average at or below 2.5 out of 5, and
 * are lower than the three before them". It needs two windows to compare, and it
 * used to ask for three entries and then compute a comparison against an empty
 * one: `prev3` was `[]`, `avg([])` is `NaN`, and `lastAvg >= NaN - 0.3` is false,
 * so the guard never fired. A patient with three low logs was told their mood was
 * declining when nothing had been compared to anything.
 *
 * The second half is the escalation. `RiskAlert.sourceType` reserved `mood` for
 * this signal, the client's risk queue already rendered `source_mood`, and no code
 * anywhere wrote the value - so a sustained decline notified the patient and
 * stopped there. The README, ARCHITECTURE.md and docs/roadmap.md each said so
 * explicitly, which is why it is worth a test rather than a code comment.
 *
 * The job acquires a Redis lock and is a no-op without one, so these call the
 * exported runner directly and assert on what it wrote.
 */

const DAY = 24 * 3600 * 1000;

/** Seeds `entries` oldest-first, one per day, ending today. */
const seedSeries = async (userId: number, entries: number[]) => {
    const now = Date.now();
    for (let i = 0; i < entries.length; i += 1) {
        // `entries` is written oldest-first, so the last element is the newest.
        const daysAgo = entries.length - 1 - i;
        await createMoodEntry(userId, entries[i], new Date(now - daysAgo * DAY));
    }
};

describe("mood-decline nudge", () => {
    let patient: Awaited<ReturnType<typeof createUser>>;

    beforeEach(async () => {
        patient = await createUser("patient");
    });

    afterEach(async () => {
        await prisma.riskAlert.deleteMany({ where: { userId: patient.id } });
        await prisma.notification.deleteMany({ where: { userId: patient.id } });
    });

    it("notifies the patient and raises an elevated alert for a real decline", async () => {
        // Six entries: the newest three average 1.67, the three before average 3.33.
        await seedSeries(patient.id, [4, 3, 3, 2, 2, 1]);

        await runCareCheckins();

        const notifications = await prisma.notification.findMany({
            where: { userId: patient.id },
        });
        expect(
            notifications.some((n) => /feel heavier/i.test(n.title)),
            "the patient should still be nudged"
        ).toBe(true);

        // The part that was missing.
        const alert = await prisma.riskAlert.findFirst({
            where: { userId: patient.id, sourceType: "mood" },
        });
        expect(alert, "the clinician should see a mood alert").toBeTruthy();
        expect(alert?.level).toBe("elevated");
        // Pointing at the evidence, so a clinician reading the queue item can go
        // straight to the logs that triggered it.
        expect(alert?.sourceId).toBeTypeOf("number");
        expect(alert?.reason).toMatch(/declined/i);
        expect(alert?.acknowledgedAt).toBeNull();
    });

    it("does nothing with only three entries, because there is nothing to compare", async () => {
        // The regression. These three average 1.67 - comfortably under the 2.5
        // threshold - so the old rule matched them on the first comparison against
        // an empty window.
        await seedSeries(patient.id, [2, 2, 1]);

        await runCareCheckins();

        expect(await prisma.riskAlert.count({ where: { userId: patient.id } })).toBe(0);
        expect(
            await prisma.notification.count({
                where: { userId: patient.id },
            })
        ).toBe(0);
    });

    it("does nothing when the average is high, however much it fell", async () => {
        // Declining from 4 to 3 is a good week, not a decline in mood.
        await seedSeries(patient.id, [4, 4, 4, 3, 3, 3]);

        await runCareCheckins();

        expect(await prisma.riskAlert.count({ where: { userId: patient.id } })).toBe(0);
    });

    it("does nothing when the average is low but flat or improving", async () => {
        // Low, but the recent three are no worse than the three before. The rule
        // is "at or below 2.5 AND declining", and the second half is what stops
        // every chronically low mood log from paging a clinician weekly.
        await seedSeries(patient.id, [2, 1, 2, 2, 1, 2]);

        await runCareCheckins();

        expect(await prisma.riskAlert.count({ where: { userId: patient.id } })).toBe(0);
    });

    it("addresses the alert to the treating clinician", async () => {
        // The reason this is a clinical signal and not a notification: somebody
        // has to receive it.
        const doctor = await createDoctor();
        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: doctor.doctorId,
                appointmentDate: new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10),
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
            });
        await doctor.agent
            .put(`/api/appointments/${book.body.data.id}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "confirmed" });

        await seedSeries(patient.id, [4, 3, 3, 2, 2, 1]);
        await runCareCheckins();

        const alert = await prisma.riskAlert.findFirst({
            where: { userId: patient.id, sourceType: "mood" },
        });
        expect(alert?.assignedDoctorUserId).toBe(doctor.id);
        expect(alert?.notifiedDoctorUserId).toBe(doctor.id);

        const notifications = await prisma.notification.findMany({
            where: { userId: doctor.id },
        });
        expect(
            notifications.some((n) => /risk disclosure/i.test(n.title)),
            "the clinician should be notified in-app"
        ).toBe(true);
    });

    it("alerts at most once a week per patient", async () => {
        await seedSeries(patient.id, [4, 3, 3, 2, 2, 1]);

        await runCareCheckins();
        await runCareCheckins();

        expect(
            await prisma.riskAlert.count({
                where: { userId: patient.id, sourceType: "mood" },
            })
        ).toBe(1);
    });
});
