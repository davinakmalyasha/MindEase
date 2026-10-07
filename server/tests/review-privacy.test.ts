/**
 * The public review listing discloses patient identity.
 *
 * `GET /api/reviews/doctor/:doctorId` is unauthenticated by design - reviews
 * belong on a doctor's public profile. But the service returns
 * `user: { id, name, avatar }` for each review, so an anonymous caller who walks
 * `/doctor/1`, `/doctor/2`, `/doctor/3` collects the real name, avatar and
 * internal user id of every patient who has ever reviewed a clinician.
 *
 * That is the identity of someone recorded as having received mental healthcare
 * from a named person, enumerable without an account. `GET /doctors/:id` already
 * had to be rewritten to an explicit allowlist for exactly this class of leak;
 * the review listing was missed because it lives behind a different file.
 *
 * Note that the doctor's own replies *should* stay attached - a clinician
 * responding publicly to a review is normal and is the point of the feature. It
 * is the reviewer's identity that must go.
 */

import { describe, it, expect } from "vitest";
import supertest from "supertest";
import { app } from "./helpers";
import { createUser, createDoctor } from "./helpers";
import { prisma } from "../src/lib/prisma";

let patientId: number;
let doctorId: number;

/**
 * Builds a completed appointment and the review on it.
 *
 * Called from each test rather than `beforeAll`, because `setup.ts` installs a
 * `beforeEach(wipeDb)` - anything created once for the file is gone by the
 * second test, which fails with a confusing "cannot read rating of undefined"
 * rather than anything resembling the real cause.
 *
 * Emails come from the helper's randomiser: a fixed address makes the file
 * un-rerunnable, since the second run collides with the first. The registered
 * *name* is deterministic, so that is what the assertions check for - and it is
 * the field that actually matters here.
 */
async function seedReview() {
    const patient = await createUser("patient");
    const doctor = await createDoctor(undefined, { verified: true });
    patientId = patient.id;
    doctorId = doctor.doctorId;

    const appt = await prisma.appointment.create({
        data: {
            userId: patientId,
            doctorId,
            appointmentDate: new Date("2026-01-05T00:00:00Z"),
            startTime: "10:00",
            endTime: "11:00",
            status: "completed",
            consultationType: "online",
        },
    });
    await prisma.review.create({
        data: {
            userId: patientId,
            doctorId,
            appointmentId: appt.id,
            rating: 5,
            comment: "Listened carefully and did not rush the session.",
        },
    });
}

describe("Public review listing must not disclose patient identity", () => {
    it("does not return the reviewer's real name to an anonymous caller", async () => {
        await seedReview();
        const res = await supertest(app).get(`/api/reviews/doctor/${doctorId}`);

        expect(res.status).toBe(200);
        const body = JSON.stringify(res.body);
        // The patient's registered name and email.
        expect(body).not.toMatch(/Test patient/);
        expect(body).not.toContain(`"userId":${patientId}`);
        // No raw user object at all.
        const review = res.body.data[0];
        expect(review.user).toBeUndefined();
    });

    it("still returns the rating, comment and the doctor's public reply", async () => {
        await seedReview();
        await prisma.review.updateMany({
            where: { doctorId },
            data: { reply: "Thank you for taking the time to write this.", repliedAt: new Date() },
        });
        const res = await supertest(app).get(`/api/reviews/doctor/${doctorId}`);
        const review = res.body.data[0];

        expect(review.rating).toBe(5);
        expect(review.comment).toContain("Listened carefully");
        // A clinician replying publicly is the feature, not a leak.
        expect(review.reply).toContain("Thank you for taking the time");
    });

    it("gives each reviewer a stable pseudonym, so replies still thread", async () => {
        await seedReview();
        const first = await supertest(app).get(`/api/reviews/doctor/${doctorId}`);
        const second = await supertest(app).get(`/api/reviews/doctor/${doctorId}`);

        expect(first.body.data[0].displayName).toBe(second.body.data[0].displayName);
        // And it is a pseudonym, not a mangled real name.
        expect(first.body.data[0].displayName).toMatch(/^[A-Z]/);
    });
});
