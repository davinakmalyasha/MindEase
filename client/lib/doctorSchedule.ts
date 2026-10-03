import type { Doctor } from "./types/doctor";

/**
 * Rendering a clinician's published availability, without inventing any.
 *
 * The profile page used to do `{doctor.availability || "Mon - Fri, 09:00 -
 * 17:00"}`. Because the API's `getDoctorById` never selected `availability`,
 * that fallback fired on *every* profile: a patient was shown a specific set of
 * consulting hours for a clinician who had never entered any. In a mental-health
 * product that is the wrong kind of wrong - it is a fabricated commitment from a
 * person, about a person.
 *
 * So: show the weekly pattern the clinician actually published, show their own
 * status label if they set one, and say "not published" when there is neither.
 * An empty schedule is a legitimate state and is rendered as one.
 */

/** Monday-first, matching `AvailabilityPattern.weekday` (0 = Monday). */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export const hasPublishedSchedule = (doctor: Pick<Doctor, "availabilityPatterns">): boolean =>
    Array.isArray(doctor.availabilityPatterns) && doctor.availabilityPatterns.length > 0;

/**
 * Groups the patterns into the days that have them, skipping empty days rather
 * than printing "Mon: -".
 *
 * A clinician who works 08:00-12:00 on three days gets one line per day. A
 * clinician who works two blocks on one day gets both, comma separated.
 */
export const formatPublishedSchedule = (doctor: Pick<Doctor, "availabilityPatterns">): string => {
    const patterns = doctor.availabilityPatterns;
    if (!Array.isArray(patterns) || patterns.length === 0) return "";

    const byDay = new Map<number, string[]>();
    for (const p of patterns) {
        const label = `${p.startTime}-${p.endTime}`;
        const existing = byDay.get(p.weekday);
        if (existing) existing.push(label);
        else byDay.set(p.weekday, [label]);
    }

    return [...byDay.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([weekday, windows]) => `${WEEKDAYS[weekday] ?? "?"}: ${windows.join(", ")}`)
        .join("  ");
};
