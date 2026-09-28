/**
 * Locale-aware formatting.
 *
 * The app previously hand-rolled `Rp {n.toLocaleString("id-ID")}` in twelve
 * places and called `toLocaleDateString` with six different hard-coded locales
 * (plus several calls with no locale argument at all). That produced a mix of
 * `Sep 27, 2026`, `27/09/2026` and `27 Sep 2026` for the same session
 * depending on the page, and — for the calls with no argument — a value that
 * differed between server and client, risking a hydration mismatch.
 *
 * Everything now goes through these helpers, which take the active locale.
 */

export type SupportedLocale = "en" | "id";

/**
 * Indonesian Rupiah.
 *
 * Whole units: a session price is never a fractional rupiah amount, and
 * `maximumFractionDigits: 0` stops `1000000` rendering as `Rp 1.000.000,00`.
 */
export const formatIDR = (amount: number | null | undefined, locale: string = "id"): string => {
    if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
    return new Intl.NumberFormat(locale === "en" ? "en-ID" : "id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
    })
        .format(amount)
        .replace(/^IDR\s?/, "Rp ");
};

/** Compact currency for dense dashboard tiles: `Rp 1,5 jt`, `Rp 250 rb`. */
export const formatIDRCompact = (
    amount: number | null | undefined,
    locale: string = "id"
): string => {
    if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
    const n = Math.abs(amount);
    if (locale === "en") {
        if (n >= 1_000_000) return `Rp ${(amount / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `Rp ${(amount / 1_000).toFixed(0)}K`;
        return formatIDR(amount, locale);
    }
    if (n >= 1_000_000) return `Rp ${(amount / 1_000_000).toFixed(1)} jt`;
    if (n >= 1_000) return `Rp ${(amount / 1_000).toFixed(0)} rb`;
    return formatIDR(amount, locale);
};

export const formatNumber = (value: number | null | undefined, locale: string = "id"): string =>
    value === null || value === undefined || Number.isNaN(value)
        ? "—"
        : new Intl.NumberFormat(locale === "en" ? "en-US" : "id-ID").format(value);

const DATE_STYLE: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
};

const DATE_TIME_STYLE: Intl.DateTimeFormatOptions = {
    ...DATE_STYLE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
};

const toDate = (value: string | number | Date | null | undefined): Date | null => {
    if (value === null || value === undefined || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

export const formatDate = (
    value: string | number | Date | null | undefined,
    locale: string = "id"
): string => {
    const date = toDate(value);
    if (!date) return "—";
    return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "id-ID", DATE_STYLE).format(date);
};

export const formatDateTime = (
    value: string | number | Date | null | undefined,
    locale: string = "id"
): string => {
    const date = toDate(value);
    if (!date) return "—";
    return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "id-ID", DATE_TIME_STYLE).format(
        date
    );
};

/** `"14:00 – 15:00"` for a slot, with an en dash between the times. */
export const formatTimeRange = (start?: string | null, end?: string | null): string => {
    if (!start) return "—";
    return end ? `${start} – ${end}` : start;
};

/**
 * A relative time such as "3 minutes ago", or `null` when the input is
 * unparseable so the caller can decide what to render.
 */
export const formatRelative = (
    value: string | number | Date | null | undefined,
    locale: string = "id"
): string | null => {
    const date = toDate(value);
    if (!date) return null;

    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const units: [Intl.RelativeTimeFormatUnit, number][] = [
        ["second", 60],
        ["minute", 60],
        ["hour", 24],
        ["day", 7],
        ["week", 4.35],
        ["month", 12],
        ["year", Number.POSITIVE_INFINITY],
    ];

    let value_ = seconds;
    for (const [unit, span] of units) {
        if (Math.abs(value_) < span || unit === "year") {
            return new Intl.RelativeTimeFormat(locale === "en" ? "en" : "id", {
                numeric: "auto",
            }).format(Math.round(value_), unit);
        }
        value_ /= span;
    }
    return null;
};
