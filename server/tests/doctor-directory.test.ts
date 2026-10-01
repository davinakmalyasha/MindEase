import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { app } from "./helpers";
import { prisma } from "../src/app";
import { invalidateDoctorCache } from "../src/services/doctor.service";

/**
 * The public doctor directory.
 *
 * This is the only endpoint in the product that needs no authentication and
 * returns data about every clinician, so it is where a mistake is both most
 * likely and most reachable. Three separate defects lived here:
 *
 *  - the response included each clinician's `phone_number`, while the detail
 *    endpoint deliberately omitted it on the stated basis that contact details
 *    are exchanged after an appointment is confirmed;
 *  - it used `include` with no `select`, so every `Doctor` scalar was
 *    serialised, including `bankName`, `bankAccount` and `bankHolder`;
 *  - the review count included `hidden: true`, so a moderated review still
 *    inflated the count shown on a card while the rating beside it - computed
 *    over visible reviews only - did not.
 *
 * And the specialty filter, which had no data behind it at all: the client
 * offered a hardcoded taxonomy with no overlap with the seeded values, so every
 * button returned an empty directory.
 */

/** `PUBLIC_FIELDS` is the contract: a directory card uses six of these. */
const PUBLIC_FIELDS = [
    "id",
    "specialty",
    "experience",
    "price",
    "rating",
    "totalReviews",
    "verificationStatus",
    "user",
    "_count",
];

const clearCache = () => invalidateDoctorCache();

const createClinician = async (overrides: Record<string, unknown> = {}) => {
    const email = `dir-${Date.now()}-${Math.floor(Math.random() * 1000)}@test.app`;
    const user = await prisma.user.create({
        data: {
            email,
            // Not a real hash - these users never authenticate.
            password: "x",
            name: "Dr Directory",
            phone_number: "+628111111111",
            role: "doctor",
            isVerified: true,
        },
    });
    return await prisma.doctor.create({
        data: {
            userId: user.id,
            specialty: (overrides.specialty as string) ?? "Trauma Therapist",
            // Required by the schema, and worth setting: `bio` is one of the
            // columns the old `include`-everything query was serialising to the
            // public directory, so a non-empty value makes the assertion below
            // meaningful rather than accidentally satisfied by a null.
            bio: "A biography long enough to be visible if the projection regresses.",
            experience: 7,
            price: 200000,
            rating: 4.5,
            totalReviews: 0,
            verificationStatus: (overrides.verificationStatus as string) ?? "approved",
            ...overrides,
        },
    });
};

describe("public doctor directory", () => {
    beforeEach(async () => {
        await clearCache();
    });
    afterAll(async () => {
        await clearCache();
        vi.restoreAllMocks();
    });

    it("never exposes a clinician's phone number", async () => {
        await createClinician();

        const res = await request(app).get("/api/doctors");

        expect(res.status).toBe(200);
        expect(res.body.data.rows.length).toBeGreaterThan(0);
        // Explicit, because a field can be absent and a deep-equality on the
        // whole user object would hide that.
        for (const row of res.body.data.rows) {
            expect(row.user.phone_number).toBeUndefined();
        }
        // Belt and braces: nothing anywhere in the payload spells the column.
        expect(JSON.stringify(res.body)).not.toContain("phone_number");
        expect(JSON.stringify(res.body)).not.toContain("bankAccount");
        expect(JSON.stringify(res.body)).not.toContain("bankHolder");
        expect(JSON.stringify(res.body)).not.toContain("bankName");
        // Nor the biography prose, which the `include`-everything query also
        // carried, a couple of kilobytes per clinician on every page load.
        expect(JSON.stringify(res.body)).not.toContain("A biography long enough");
    });

    it("returns only the projected fields", async () => {
        await createClinician();
        const res = await request(app).get("/api/doctors");
        expect(res.status).toBe(200);

        const row = res.body.data.rows[0];
        expect(Object.keys(row).sort()).toEqual([...PUBLIC_FIELDS].sort());
        // The user projection is exactly name + avatar.
        expect(Object.keys(row.user).sort()).toEqual(["avatar", "name"]);
    });

    it("counts only reviews a patient can actually see", async () => {
        const doctor = await createClinician();
        const patient = await prisma.user.create({
            data: {
                email: `rev-${Date.now()}@test.app`,
                password: "x",
                name: "Reviewer",
                role: "patient",
                isVerified: true,
            },
        });
        const visible = await prisma.review.create({
            data: { doctorId: doctor.id, userId: patient.id, rating: 5, comment: "Helpful." },
        });
        await prisma.review.create({
            data: {
                doctorId: doctor.id,
                userId: patient.id,
                rating: 1,
                comment: "Reported and hidden.",
                hidden: true,
            },
        });

        await clearCache();
        const res = await request(app).get("/api/doctors");
        const row = res.body.data.rows.find((r: { id: number }) => r.id === doctor.id);

        expect(row).toBeTruthy();
        // Two reviews exist; one is moderated away. Showing "2" next to a rating
        // computed over one review is a claim the page cannot support, and it
        // tells a visitor which reviews moderation is touching.
        expect(row._count.reviews).toBe(1);
        expect(visible.id).toBeTruthy();
    });

    it("hides a clinician who is not approved", async () => {
        const pending = await createClinician({
            specialty: "Pending Specialty",
            verificationStatus: "pending",
        });
        const res = await request(app).get("/api/doctors");
        expect(res.status).toBe(200);
        expect(res.body.data.rows.map((r: { id: number }) => r.id)).not.toContain(pending.id);
        // And the same clinician contributes no filter value either.
        const specialties = await request(app).get("/api/doctors/specialties");
        expect(specialties.body.data).not.toContain("Pending Specialty");
    });

    it("serves each page size its own cached response", async () => {
        // The cache key used to ignore `limit`, so the 20-per-page directory and
        // the 50-per-page booking page shared one entry and whichever landed
        // first dictated the other's row count and totalPages for the whole TTL.
        await createClinician({ specialty: "Cache Probe" });

        const twenty = await request(app).get("/api/doctors?page=1&limit=20");
        const fifty = await request(app).get("/api/doctors?page=1&limit=50");

        expect(twenty.status).toBe(200);
        expect(fifty.status).toBe(200);
        // Both are internally consistent for their own page size.
        const expected20 = Math.ceil(twenty.body.data.total / 20);
        const expected50 = Math.ceil(fifty.body.data.total / 50);
        expect(twenty.body.data.totalPages).toBe(expected20);
        expect(fifty.body.data.totalPages).toBe(expected50);
    });

    describe("GET /api/doctors/specialties", () => {
        it("returns the specialties approved clinicians actually have", async () => {
            // The regression: the sidebar offered a hardcoded taxonomy with zero
            // overlap with the seeded values, so every filter returned nothing.
            await createClinician({ specialty: "Grief Specialist" });
            await createClinician({ specialty: "Grief Specialist" });
            await createClinician({ specialty: "Sleep Specialist" });

            await clearCache();
            const res = await request(app).get("/api/doctors/specialties");

            expect(res.status).toBe(200);
            expect(res.body.data).toContain("Grief Specialist");
            expect(res.body.data).toContain("Sleep Specialist");
        });

        it("de-duplicates and excludes a clinician who is not approved", async () => {
            await createClinician({ specialty: "Duplicated Specialty" });
            await createClinician({ specialty: "Duplicated Specialty" });
            await createClinician({ specialty: "Unapproved Specialty", verificationStatus: "pending" });

            await clearCache();
            const res = await request(app).get("/api/doctors/specialties");

            const count = (s: string) => res.body.data.filter((x: string) => x === s).length;
            expect(count("Duplicated Specialty")).toBe(1);
            expect(res.body.data).not.toContain("Unapproved Specialty");
        });

        it("is served before the /:id catch-all rather than parsed as an id", async () => {
            // A route-order regression here returns a 400 from `idParam` rather
            // than the list, which reads like an empty platform.
            const res = await request(app).get("/api/doctors/specialties");
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.data)).toBe(true);
        });
    });
});
