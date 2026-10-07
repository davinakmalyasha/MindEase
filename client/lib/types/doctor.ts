/**
 * The specialty taxonomy is owned by the data, not by this file.
 *
 * This used to export a hardcoded `SPECIALTIES` array of seven names -
 * "Psychology", "Psychiatry", "Counseling", "Pediatric", "Neuropsychology",
 * "Clinical" - which the filter sidebar offered to the patient. The seed
 * creates eight entirely different values: "Clinical Psychologist", "Family
 * Counselor", "Trauma Therapist", "Addiction Specialist". There was no overlap,
 * so every one of those buttons returned an empty directory.
 *
 * The list now comes from `GET /api/doctors/specialties`, which derives it from
 * the approved clinicians actually on the platform, and the sidebar renders
 * `specialty` as a plain `string`. Nothing can drift out of sync, because there
 * is only one list.
 */
export const ITEMS_PER_PAGE = 8;

export interface Doctor {
    id: number;
    userId?: number;
    name: string;
    /**
     * Free text, as the column is.
     *
     * Previously typed as a `Specialty` union, which the API has never returned.
     * The annotation was satisfied by casting rather than by the data.
     */
    specialty: string;
    avatar: string;
    image?: string; // Added for UI compatibility
    rating: number;
    reviewCount: number;
    experience: number;
    isAvailable: boolean;
    isVerified: boolean;
    bio: string;
    price: number;
    /**
     * The clinician's own free-text availability label, or absent.
     *
     * Optional and nullable on purpose. This is a status word the clinician
     * typed, not a schedule, and the profile page previously fell back to a
     * hardcoded "Mon - Fri, 09:00 - 17:00" whenever it was missing - which is
     * how a patient was told a clinician's hours that the clinician had never
     * entered. Absent means absent.
     */
    availability?: string | null;
    /**
     * The clinician's real recurring weekly schedule.
     *
     * The authoritative answer to "when are they available", and empty when the
     * clinician has published none. Rendered as "not published" rather than
     * substituted with a guess.
     */
    availabilityPatterns?: { weekday: number; startTime: string; endTime: string }[] | null;
    /**
     * Stated by the clinician. The API has always returned these; the profile
     * page previously ignored them and rendered a fixed list of clinical focus
     * areas instead, which asserted a scope for every psychologist in the
     * directory that nothing in the data supported.
     */
    languages?: string | null;
    education?: string | null;
    /** Free-text until the specialty taxonomy lands. */
    licenseNumber?: string | null;
    licenseIssuer?: string | null;
    /** Open slots, when the endpoint supplied them. Not on the directory list. */
    consultationSlots?: unknown[];
}

export interface AppointmentWithDoctor {
    id: number;
    appointmentDate: string;
    status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
    notes?: string;
    consultationType?: string;
    startTime?: string;
    endTime?: string;
    doctor: {
        id: number;
        name: string;
        specialty: string;
        avatar: string;
        rating: number;
        user?: {
            name?: string;
            avatar?: string;
            phone_number?: string;
        };
    };
    user?: {
        name: string;
        avatar: string;
        phone_number?: string;
    };
}

export interface FilterParams {
    search: string;
    specialty: string;
    minExperience: number;
    availableOnly: boolean;
    page: number;
}
