import type { Doctor } from "./types/doctor";

/**
 * The one place an API doctor becomes a UI doctor.
 *
 * This used to be duplicated as a `mapDoctor` in both the directory and the
 * detail page, and both copies silently dropped `languages`, `education`,
 * `licenseNumber` and `licenseIssuer` - so the API returned a clinician's
 * licence and the UI threw it away, leaving `DoctorProfile` rendering section
 * headers above permanently-empty blocks.
 *
 * The two copies were not even equivalent: the detail page took `userId` and
 * `reviewCount` from a different place than the directory did. One mapper
 * removes the possibility of the two drifting again.
 *
 * Everything optional stays optional and null-preserving. The point of the
 * credentials work is to show what a clinician has actually stated, which
 * means being equally clear when they have stated nothing.
 */
export interface ApiDoctor {
    id: number;
    specialty: string;
    bio?: string | null;
    experience?: number | null;
    price?: number | null;
    rating?: number | null;
    totalReviews?: number | null;
    languages?: string | null;
    education?: string | null;
    licenseNumber?: string | null;
    licenseIssuer?: string | null;
    verificationStatus?: string | null;
    availability?: string | null;
    availabilityPatterns?: { weekday: number; startTime: string; endTime: string }[] | null;
    user?: { id?: number; name?: string | null; avatar?: string | null } | null;
    reviews?: unknown[] | null;
    _count?: { reviews?: number | null } | null;
    consultationSlots?: unknown[];
    [key: string]: unknown;
}

export const mapDoctor = (d: ApiDoctor): Doctor => ({
    id: d.id,
    userId: d.user?.id,
    name: d.user?.name || "Doctor",
    specialty: d.specialty,
    avatar: d.user?.avatar || "",
    image: d.user?.avatar || "",
    // Deliberately not defaulted to a positive number. A clinician with no
    // reviews is the normal case; a 4.8 shown to a patient is a fabricated
    // clinical claim, which is why the seed stopped inventing ratings too.
    rating: d.rating ?? 0,
    reviewCount: d._count?.reviews ?? d.reviews?.length ?? d.totalReviews ?? 0,
    experience: d.experience ?? 0,
    // Derived from the clinician's own label. Absent means unknown, not busy -
    // defaulting it to false would hide every clinician who never typed one.
    isAvailable: d.availability === "Available",
    isVerified: d.verificationStatus === "approved",
    bio: d.bio || "",
    price: d.price ?? 0,
    availability: d.availability ?? null,
    availabilityPatterns: d.availabilityPatterns ?? null,
    languages: d.languages ?? null,
    education: d.education ?? null,
    licenseNumber: d.licenseNumber ?? null,
    licenseIssuer: d.licenseIssuer ?? null,
    consultationSlots: d.consultationSlots,
});
