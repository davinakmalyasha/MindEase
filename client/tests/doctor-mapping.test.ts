import { describe, it, expect } from "vitest";
import { mapDoctor, type ApiDoctor } from "@/lib/mapDoctor";
import {
    hasPublishedSchedule,
    formatPublishedSchedule,
} from "@/lib/doctorSchedule";

/**
 * The rule this file exists to protect: **the client must not invent a clinical
 * claim about a clinician.**
 *
 * Both modules under test were written to stop the UI from stating something
 * untrue, and both had no tests. A "safe default" is exactly the kind of value
 * that gets refactored back to a friendlier-looking one by somebody who reads it
 * as a formatting detail.
 *
 * The two bugs these replaced, for context:
 *
 *  - `getDoctorById` never selected `availability`, so
 *    `{doctor.availability || "Mon - Fri, 09:00 - 17:00"}` fired on *every*
 *    profile. Every patient saw specific consulting hours for a clinician who
 *    had never entered any - a fabricated commitment from a person, about a
 *    person.
 *  - `mapDoctor` was duplicated in the directory and the detail page, and both
 *    copies dropped `languages`, `education`, `licenseNumber` and
 *    `licenseIssuer`, so `DoctorProfile` rendered section headers above
 *    permanently-empty blocks.
 */

const api = (overrides: Partial<ApiDoctor> = {}): ApiDoctor => ({
    id: 1,
    specialty: "Clinical Psychologist",
    ...overrides,
});

describe("mapDoctor", () => {
    it("does not invent a rating for a clinician with no reviews", () => {
        // A clinician with no reviews is the normal case. Showing 4.8 to a
        // patient is a fabricated clinical claim, which is why the seed stopped
        // inventing ratings too.
        expect(mapDoctor(api()).rating).toBe(0);
        expect(mapDoctor(api({ rating: null })).rating).toBe(0);
        // And a real one survives.
        expect(mapDoctor(api({ rating: 4.7 })).rating).toBe(4.7);
    });

    it("does not default an unstated availability to 'busy'", () => {
        // `isAvailable: false` is the classic lie here. Absent means unknown,
        // and defaulting to false hides every clinician who never typed a label.
        expect(mapDoctor(api()).isAvailable).toBe(false);
        expect(mapDoctor(api({ availability: "Available" })).isAvailable).toBe(true);
        expect(mapDoctor(api({ availability: "On leave" })).isAvailable).toBe(false);
    });

    it("only reports verified for an approved clinician", () => {
        expect(mapDoctor(api({ verificationStatus: "approved" })).isVerified).toBe(true);
        // Pending, removed, and absent are all "not verified", and a removed
        // clinician must not render with a verified badge.
        expect(mapDoctor(api({ verificationStatus: "pending" })).isVerified).toBe(false);
        expect(mapDoctor(api({ verificationStatus: "removed" })).isVerified).toBe(false);
        expect(mapDoctor(api()).isVerified).toBe(false);
    });

    it("carries the credentials through instead of dropping them", () => {
        // The original mapper silently discarded these, which left
        // `DoctorProfile` rendering section headers above empty blocks.
        const mapped = mapDoctor(
            api({
                languages: "Indonesian, English",
                education: "M.Psi, Universitas Indonesia",
                licenseNumber: "12345",
                licenseIssuer: "IAPI",
            })
        );
        expect(mapped.languages).toBe("Indonesian, English");
        expect(mapped.education).toBe("M.Psi, Universitas Indonesia");
        expect(mapped.licenseNumber).toBe("12345");
        expect(mapped.licenseIssuer).toBe("IAPI");
    });

    it("preserves a null credential as null rather than inventing one", () => {
        // Equally clear when they have stated nothing.
        const mapped = mapDoctor(api());
        expect(mapped.languages).toBeNull();
        expect(mapped.education).toBeNull();
        expect(mapped.licenseNumber).toBeNull();
        expect(mapped.licenseIssuer).toBeNull();
        expect(mapped.bio).toBe("");
    });

    it("prefers the server's own review count and falls back sensibly", () => {
        // Three sources, in order, because the directory returns `_count` and the
        // detail page returns a `reviews` array.
        expect(mapDoctor(api({ _count: { reviews: 7 } })).reviewCount).toBe(7);
        expect(mapDoctor(api({ reviews: [1, 2, 3] })).reviewCount).toBe(3);
        expect(mapDoctor(api({ totalReviews: 2 })).reviewCount).toBe(2);
        expect(mapDoctor(api()).reviewCount).toBe(0);
    });

    it("does not crash on a missing user object", () => {
        const mapped = mapDoctor(api());
        expect(mapped.name).toBe("Doctor");
        expect(mapped.avatar).toBe("");
        expect(mapped.userId).toBeUndefined();
    });

    it("mirrors the avatar into `image` for UI compatibility", () => {
        // Two fields, one source. They existed because a component read
        // `image` and the API returned `avatar`, and duplicating it at the mapper
        // is better than at every call site.
        const mapped = mapDoctor(api({ user: { id: 9, name: "Dr Asha", avatar: "/uploads/a.png" } }));
        expect(mapped.avatar).toBe("/uploads/a.png");
        expect(mapped.image).toBe("/uploads/a.png");
        expect(mapped.name).toBe("Dr Asha");
    });
});

describe("published availability", () => {
    it("reports no schedule when none was published", () => {
        expect(hasPublishedSchedule({ availabilityPatterns: null })).toBe(false);
        expect(hasPublishedSchedule({ availabilityPatterns: [] })).toBe(false);
        expect(
            hasPublishedSchedule({
                availabilityPatterns: [{ weekday: 1, startTime: "09:00", endTime: "17:00" }],
            })
        ).toBe(true);
    });

    it("returns an empty string rather than a fallback for an empty schedule", () => {
        // The regression this whole module exists for: the profile page used to
        // render `doctor.availability || "Mon - Fri, 09:00 - 17:00"`, and because
        // the API never selected `availability` that string appeared on every
        // single profile. An empty schedule is a legitimate state and has to
        // render as one.
        expect(formatPublishedSchedule({ availabilityPatterns: null })).toBe("");
        expect(formatPublishedSchedule({ availabilityPatterns: [] })).toBe("");
    });

    it("groups by weekday, Monday first", () => {
        // Deliberately out of order, because a clinician's patterns arrive in
        // whatever order the database returned them. `weekday` is 0-indexed with
        // 0 = Monday, matching `AvailabilityPattern.weekday` on the server.
        const out = formatPublishedSchedule({
            availabilityPatterns: [
                { weekday: 3, startTime: "10:00", endTime: "14:00" },
                { weekday: 0, startTime: "09:00", endTime: "12:00" },
                { weekday: 1, startTime: "09:00", endTime: "17:00" },
            ],
        });
        expect(out).toBe("Mon: 09:00-12:00  Tue: 09:00-17:00  Thu: 10:00-14:00");
    });

    it("keeps two blocks on the same day on one line", () => {
        const out = formatPublishedSchedule({
            availabilityPatterns: [
                { weekday: 2, startTime: "09:00", endTime: "12:00" },
                { weekday: 2, startTime: "14:00", endTime: "18:00" },
            ],
        });
        expect(out).toBe("Wed: 09:00-12:00, 14:00-18:00");
    });

    it("skips days with nothing on them rather than printing an empty row", () => {
        const out = formatPublishedSchedule({
            availabilityPatterns: [
                { weekday: 0, startTime: "09:00", endTime: "12:00" },
                { weekday: 4, startTime: "09:00", endTime: "17:00" },
            ],
        });
        expect(out).toBe("Mon: 09:00-12:00  Fri: 09:00-17:00");
        // A clinician who works two days does not get seven lines.
        expect(out.split("  ")).toHaveLength(2);
    });

    it("does not crash on a weekday outside the range", () => {
        // `AvailabilityPattern.weekday` is 0-6 with 0 = Monday. A value outside
        // that is a data bug, and a "?" is better than a render-time throw or a
        // silently dropped line.
        const out = formatPublishedSchedule({
            availabilityPatterns: [{ weekday: 9, startTime: "09:00", endTime: "17:00" }],
        });
        expect(out).toBe("?: 09:00-17:00");
    });
});
