/**
 * Timezone-aware date helpers.
 *
 * Every "day" boundary in this application — the mood log day, the streak, the
 * 24-hour cancellation grace window, the reminder window, the weekly-report
 * cadence — was computed with server-local `new Date(y, m, d)` calls. On a UTC
 * host (the Railway default) that is seven hours wrong for WIB users, so a
 * mood logged at 00:30 local counted as the previous day and a reminder could
 * arrive after the session had started.
 *
 * `User.timezone` already existed but was never read. These helpers are the
 * single place where an instant is converted to a calendar day in a specific
 * zone, so the conversion cannot drift between call sites.
 *
 * Two distinct notions live here, and mixing them up is the bug this file
 * exists to prevent:
 *
 *   - **User-zone day math** (`dayKey`, `startOfZonedDay`, `shiftDayKey`) —
 *     "which calendar day did this instant fall on, for this user". Use for
 *     streaks, mood windows, reminder cadence, anything the user perceives.
 *   - **Server-local calendar dates** (`parseLocalDate`, `localDateKey`) — how
 *     slot and appointment dates are *stored*: a `YYYY-MM-DD` string means
 *     midnight in the server's own zone. This predates the user-zone helpers
 *     and is retained so existing rows and the availability UI keep agreeing.
 */

export const DEFAULT_TIMEZONE = "Asia/Jakarta";

const isValidTimezone = (tz: string): boolean => {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
};

export const resolveTimezone = (tz?: string | null): string => {
    if (!tz || !isValidTimezone(tz)) return DEFAULT_TIMEZONE;
    return tz;
};

const partsFormatter = (timezone: string) =>
    new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });

/** `YYYY-MM-DD` for the given instant, as seen in `timezone`. */
export const dayKey = (at: Date, timezone: string): string => {
    const parts = partsFormatter(timezone).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
    return `${get("year")}-${get("month")}-${get("day")}`;
};

/**
 * The UTC instant at which the given calendar day begins in `timezone`.
 * Used as a range bound, so the database comparison is timezone-safe.
 */
export const startOfZonedDay = (key: string, timezone: string): Date => {
    // Start from the nominal UTC reading of the key, then correct by the
    // zone's offset at that moment (two passes settle DST transitions).
    let guess = new Date(`${key}T00:00:00.000Z`);
    for (let i = 0; i < 2; i++) {
        const offset = zoneOffsetMs(guess, timezone);
        guess = new Date(new Date(`${key}T00:00:00.000Z`).getTime() - offset);
    }
    return guess;
};

const zoneOffsetMs = (at: Date, timezone: string): number => {
    const parts = partsFormatter(timezone).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
    const asUTC = Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour") % 24,
        get("minute"),
        get("second")
    );
    return asUTC - at.getTime();
};

/** Steps `count` calendar days back from `key`, staying in `timezone`. */
export const shiftDayKey = (key: string, count: number, timezone: string): string => {
    const base = startOfZonedDay(key, timezone);
    // Shift by whole days in the zone's own frame, then read the day back out.
    const shifted = new Date(base.getTime() + count * 24 * 60 * 60 * 1000 + zoneOffsetMs(base, timezone));
    return dayKey(shifted, timezone);
};

/** The `YYYY-MM-DD` key for "now" in the user's zone. */
export const todayKey = (timezone: string, now: Date = new Date()): string => dayKey(now, timezone);

/** `"HH:mm"` in 24-hour form for the given instant in the user's zone. */
export const timeKey = (at: Date, timezone: string): string => {
    const parts = partsFormatter(timezone).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
    // Intl renders midnight as "24" under `hour12: false` in some ICU versions.
    const hour = Number(get("hour")) % 24;
    return `${String(hour).padStart(2, "0")}:${get("minute")}`;
};

/**
 * `"HH:mm"` to minutes past midnight.
 *
 * Slot and appointment times are stored as strings, and comparing them
 * lexicographically makes `"10:00" < "9:00"` true — which is how the
 * availability overlap check ended up accepting genuinely overlapping slots.
 */
export const timeToMinutes = (hhmm: string): number => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!match) return NaN;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 24 || minutes > 59) return NaN;
    return hours * 60 + minutes;
};

/** Half-open overlap test: `[aStart, aEnd)` against `[bStart, bEnd)`. */
export const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => {
    if ([aStart, aEnd, bStart, bEnd].some((n) => Number.isNaN(n))) return false;
    return aStart < bEnd && bStart < aEnd;
};

/* ------------------------------------------------------------------ *
 * Server-local calendar dates (how slot/appointment dates are stored)
 * ------------------------------------------------------------------ */

/**
 * Calendar dates sent over the API are interpreted as local midnight — matching
 * how the UI and slot storage behave — instead of the JavaScript default of UTC
 * midnight, which drifts by one day in any non-UTC timezone.
 */
export const parseLocalDate = (value: string | Date): Date => {
    if (value instanceof Date) return value;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (match) {
        return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }
    return new Date(value);
};

export const localDateKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
