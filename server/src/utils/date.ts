/**
 * Timezone-safe date helpers.
 *
 * Calendar dates ("YYYY-MM-DD") sent over the API are interpreted as LOCAL
 * midnight — matching how the UI and slot storage behave — instead of the
 * JavaScript default of UTC midnight, which drifts by one day in any
 * non-UTC timezone.
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
