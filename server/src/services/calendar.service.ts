/**
 * Minimal RFC-5545 iCalendar builder — no external dependency needed.
 */

const esc = (v: string) =>
    v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// UTC with Z suffix — unambiguous for every calendar client, regardless of
// the timezone the server (or the importer) runs in.
const formatIcsDate = (d: Date) =>
    d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export interface IcsEvent {
    summary: string;
    description?: string;
    location?: string;
    start: Date;
    end: Date;
    uid: string;
}

export const buildIcs = (event: IcsEvent): string => {
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//MindEase//MindEase Consultations//EN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        `UID:${event.uid}@mindease.app`,
        `DTSTAMP:${formatIcsDate(new Date())}`,
        `DTSTART:${formatIcsDate(event.start)}`,
        `DTEND:${formatIcsDate(event.end)}`,
        `SUMMARY:${esc(event.summary)}`,
    ];
    if (event.description) lines.push(`DESCRIPTION:${esc(event.description)}`);
    if (event.location) lines.push(`LOCATION:${esc(event.location)}`);
    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
};
