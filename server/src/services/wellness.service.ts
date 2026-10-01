import { prisma } from "../lib/prisma";
import { AIService } from "./ai.service";
import { detectAssessmentRisk, raiseRiskAlert, NO_RISK } from "./clinicalSafety.service";
import { dayKey, resolveTimezone, shiftDayKey, startOfZonedDay, todayKey } from "../lib/date";
import { badRequest, notFound } from "../utils/appError";
import { sanitize } from "../utils/sanitize";

export const MOOD_FACTORS = ["sleep", "exercise", "social", "work", "stress"] as const;
export type MoodFactor = (typeof MOOD_FACTORS)[number];

export const ASSESSMENT_TYPES = ["phq9", "gad7"] as const;
export type AssessmentType = (typeof ASSESSMENT_TYPES)[number];

export const ASSESSMENT_QUESTION_COUNTS: Record<AssessmentType, number> = {
    phq9: 9,
    gad7: 7,
};

/**
 * The two instruments, described once.
 *
 * Both are self-report *screening* instruments. They indicate whether further
 * assessment is warranted; they do not diagnose, and the product must not
 * present them as though they do. `max` is the instrument's own top score -
 * they differ, which is exactly why both instruments can never share an axis.
 *
 * Sourced here rather than in the client so a chart cannot quietly disagree
 * with the server about where a band starts.
 */
export const INSTRUMENTS: Record<
    AssessmentType,
    { label: string; max: number; bands: { upTo: number; severity: string }[] }
> = {
    phq9: {
        label: "PHQ-9",
        max: 27,
        bands: [
            { upTo: 4, severity: "minimal" },
            { upTo: 9, severity: "mild" },
            { upTo: 14, severity: "moderate" },
            { upTo: 19, severity: "moderately-severe" },
            { upTo: 27, severity: "severe" },
        ],
    },
    gad7: {
        label: "GAD-7",
        max: 21,
        bands: [
            { upTo: 4, severity: "minimal" },
            { upTo: 9, severity: "mild" },
            { upTo: 14, severity: "moderate" },
            { upTo: 21, severity: "severe" },
        ],
    },
};

/**
 * "Fewer than three sittings" is the honest answer for anything shorter.
 * A single sitting is not a trend, and a two-point difference between two
 * measurements is inside the noise of a self-report instrument.
 */
const describeDirection = (
    totalChange: number | null,
    sittings: number
): "improving" | "worsening" | "stable" | "insufficient-data" => {
    if (totalChange === null || sittings < 3) return "insufficient-data";
    if (totalChange <= -3) return "improving";
    if (totalChange >= 3) return "worsening";
    return "stable";
};

const severityFor = (type: AssessmentType, score: number): string => {
    if (type === "phq9") {
        if (score <= 4) return "minimal";
        if (score <= 9) return "mild";
        if (score <= 14) return "moderate";
        if (score <= 19) return "moderately-severe";
        return "severe";
    }
    if (score <= 4) return "minimal";
    if (score <= 9) return "mild";
    if (score <= 14) return "moderate";
    return "severe";
};

const parseFactors = (raw: string | null): MoodFactor[] => {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((f) => MOOD_FACTORS.includes(f)) : [];
    } catch {
        return [];
    }
};

export class WellnessService {
    static async logMood(userId: number, mood: number, notes?: string, factors?: string[]) {
        if (mood < 1 || mood > 5) throw badRequest("Mood must be between 1 and 5.");

        const validFactors = (factors || []).filter((f) => (MOOD_FACTORS as readonly string[]).includes(f));
        // Sanitised on the way in, like every other free-text field in the
        // codebase. These notes are the patient writing about their own mental
        // state, they are surfaced verbatim in the clinician pre-session
        // briefing and in the AI briefing prompt, and nothing was stripping
        // markup from them.
        const data = {
            mood,
            notes: notes ? sanitize(notes) : null,
            factors: validFactors.length ? JSON.stringify(validFactors) : null,
        };

        // One entry per calendar day in the *user's* zone, keyed by a stored
        // `moodDate` day key rather than a range scan on `createdAt`.
        //
        // The previous implementation did a find-then-create against a
        // server-local day range, which is race-prone (two concurrent requests
        // both see "no entry" and both insert) and off-by-seven-hours on a UTC
        // host. A unique constraint on (userId, moodDate) makes the invariant
        // a database guarantee, so an upsert is idempotent under concurrency.
        const timezone = await this.getUserTimezone(userId);
        const moodDate = todayKey(timezone);

        // Read-before-upsert purely to tell the caller whether it created or
        // replaced today's entry. The unique constraint is what actually
        // guarantees the invariant; this pre-read is a display hint and a lost
        // race only ever mislabels the toast, never duplicates a row.
        const existing = await prisma.moodEntry.findUnique({
            where: { userId_moodDate: { userId, moodDate } },
            select: { id: true },
        });

        const entry = await prisma.moodEntry.upsert({
            where: { userId_moodDate: { userId, moodDate } },
            create: { userId, moodDate, ...data },
            update: data,
        });

        // Surfaced so the UI can be honest about the fact that a same-day
        // re-log overwrites the earlier entry instead of silently discarding it.
        return { ...entry, replaced: existing !== null };
    }

    static async getMoodHistory(userId: number, days = 14) {
        const timezone = await this.getUserTimezone(userId);
        const today = todayKey(timezone);
        const since = startOfZonedDay(shiftDayKey(today, -days, timezone), timezone);

        const entries = await prisma.moodEntry.findMany({
            where: {
                userId,
                createdAt: { gte: since },
            },
            orderBy: { createdAt: "desc" },
            // Bounded so a wide window cannot return an unbounded result set.
            take: Math.max(days, 1) * 2,
        });

        return entries.map((e) => ({ ...e, factors: parseFactors(e.factors) }));
    }

    /** `User.timezone` is optional and was previously never read at all. */
    private static async getUserTimezone(userId: number): Promise<string> {
        const user = await prisma.user
            .findUnique({ where: { id: userId }, select: { timezone: true } })
            .catch(() => null);
        return resolveTimezone(user?.timezone);
    }

    static async getMoodStats(userId: number, windowDays = 30) {
        const timezone = await this.getUserTimezone(userId);
        const today = todayKey(timezone);

        // A genuine 30-*day* window. This previously read `take: 30` entries,
        // which spans 30 days only when the user logs exactly once a day — with
        // any gap the "30-day average" silently covered a much longer period.
        const from = startOfZonedDay(shiftDayKey(today, -(windowDays - 1), timezone), timezone);

        const entries = await prisma.moodEntry.findMany({
            where: { userId, createdAt: { gte: from } },
            orderBy: { createdAt: "asc" },
            select: { mood: true, factors: true, createdAt: true },
        });

        if (entries.length === 0) {
            return {
                average: 0,
                total: 0,
                streak: 0,
                trend: "stable" as const,
                factorCorrelation: {},
                windowDays,
            };
        }

        const average = entries.reduce((sum, e) => sum + e.mood, 0) / entries.length;

        // Streak of consecutive logged days in the user's own zone.
        //
        // The old loop required an entry for *today* before counting, so a user
        // who logged at 23:50 yesterday and had not yet logged today saw their
        // streak drop to 0. Today is given a grace period: the streak is intact
        // if the most recent entry is today *or* yesterday.
        const loggedDays = new Set(entries.map((e) => dayKey(e.createdAt, timezone)));
        const yesterday = shiftDayKey(today, -1, timezone);
        let streak = 0;
        let cursor = loggedDays.has(today) ? today : yesterday;
        if (!loggedDays.has(cursor)) {
            streak = 0;
        } else {
            while (loggedDays.has(cursor) && streak < 400) {
                streak++;
                cursor = shiftDayKey(cursor, -1, timezone);
            }
        }

        // Trend compares the older half of the window against the newer half.
        //
        // The previous arithmetic divided the newest `floor(n/2)` entries by
        // that same `floor(n/2)`, so with a single entry `mid` was 0, the recent
        // average became 0 and a perfectly good day scored 4/5 was reported as
        // "declining". Requires at least 4 points to say anything at all.
        const TREND_THRESHOLD = 0.3;
        let trend: "improving" | "declining" | "stable" = "stable";
        if (entries.length >= 4) {
            const mid = Math.floor(entries.length / 2);
            const older = entries.slice(0, mid);
            const recent = entries.slice(mid);
            const olderAvg = older.reduce((s, e) => s + e.mood, 0) / older.length;
            const recentAvg = recent.reduce((s, e) => s + e.mood, 0) / recent.length;
            if (recentAvg > olderAvg + TREND_THRESHOLD) trend = "improving";
            else if (recentAvg < olderAvg - TREND_THRESHOLD) trend = "declining";
        }

        // Factor correlation: average mood per factor tag
        const factorCorrelation: Record<string, number> = {};
        for (const factor of MOOD_FACTORS) {
            const tagged = entries.filter((e) => parseFactors(e.factors).includes(factor));
            if (tagged.length > 0) {
                factorCorrelation[factor] =
                    Math.round((tagged.reduce((s, e) => s + e.mood, 0) / tagged.length) * 10) / 10;
            }
        }

        return {
            average: Math.round(average * 10) / 10,
            total: entries.length,
            streak,
            trend,
            factorCorrelation,
            windowDays,
        };
    }

    static async createJournalEntry(userId: number, content: string) {
        return await prisma.journalEntry.create({
            data: { userId, content: sanitize(content) },
        });
    }

    // Owner-checked edit/delete for journal entries
    static async updateJournalEntry(userId: number, entryId: number, content: string) {
        const entry = await prisma.journalEntry.findUnique({ where: { id: entryId } });
        if (!entry || entry.userId !== userId) throw notFound("Journal entry not found");
        return await prisma.journalEntry.update({
            where: { id: entryId },
            data: { content: sanitize(content) },
        });
    }

    static async deleteJournalEntry(userId: number, entryId: number) {
        const entry = await prisma.journalEntry.findUnique({ where: { id: entryId } });
        if (!entry || entry.userId !== userId) throw notFound("Journal entry not found");
        await prisma.journalEntry.delete({ where: { id: entryId } });
        return { success: true };
    }

    static async getJournalEntries(userId: number, limit = 20) {
        return await prisma.journalEntry.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: Math.min(limit, 100),
        });
    }

    static async summarizeJournal(userId: number) {
        const entries = await prisma.journalEntry.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: 7,
        });
        if (entries.length === 0) return { summary: null, count: 0 };

        const summary = await AIService.summarizeJournal(
            entries.map((e) => e.content),
            new Date(entries[entries.length - 1].createdAt),
            new Date(entries[0].createdAt)
        );

        return {
            summary: summary.data,
            count: entries.length,
            ai: { source: summary.source, degradedReason: summary.degradedReason },
        };
    }

    static async submitAssessment(userId: number, type: string, answers: number[]) {
        if (!(ASSESSMENT_TYPES as readonly string[]).includes(type)) {
            throw badRequest("Assessment type must be phq9 or gad7");
        }
        const questionCount = ASSESSMENT_QUESTION_COUNTS[type as AssessmentType];
        if (!Array.isArray(answers) || answers.length !== questionCount) {
            throw badRequest(`Assessment requires exactly ${questionCount} answers`);
        }
        if (!answers.every((a) => Number.isInteger(a) && a >= 0 && a <= 3)) {
            throw badRequest("Each answer must be an integer between 0 and 3");
        }

        const score = answers.reduce((s, a) => s + a, 0);
        const severity = severityFor(type as AssessmentType, score);

        const assessment = await prisma.assessment.create({
            data: {
                userId,
                type,
                answersJson: JSON.stringify(answers),
                score,
                severity,
            },
        });

        // A non-zero answer to PHQ-9 item 9 is a disclosure of thoughts of
        // self-harm. It is surfaced to the patient immediately with crisis
        // resources and escalated to the assigned clinician, rather than being
        // folded silently into the total score.
        const risk = detectAssessmentRisk(type, answers);
        if (!risk) {
            return { assessment, risk: { riskFlag: false, ...NO_RISK } };
        }

        const user = await prisma.user
            .findUnique({ where: { id: userId }, select: { name: true } })
            .catch(() => null);

        const signal = await raiseRiskAlert({
            userId,
            userName: user?.name,
            level: risk.level,
            reason: risk.reason,
            sourceType: type,
            sourceId: assessment.id,
        });

        return { assessment, risk: signal };
    }

    static async getAssessments(userId: number, type?: string, limit = 10) {
        return await prisma.assessment.findMany({
            where: {
                userId,
                ...(type && (ASSESSMENT_TYPES as readonly string[]).includes(type) ? { type } : {}),
            },
            orderBy: { createdAt: "desc" },
            take: Math.min(limit, 100),
        });
    }

    /**
     * A scored series for one instrument, oldest first, with the change since
     * the previous sitting.
     *
     * The clinical framing belongs here, not in the chart. A screening
     * instrument moving from 18 to 11 is a change in a *screening score*, and
     * the response says so explicitly rather than reporting "an 7-point
     * improvement", which reads as a treatment effect. PHQ-9 and GAD-7 are
     * screening tools; they are not diagnoses, and a trend line is not
     * evidence of recovery.
     *
     * `bands` travels with the data so a client cannot invent its own cut-offs
     * and get them subtly wrong per instrument - the two scales differ, and
     * both are already wrong in most client code that hardcodes them.
     */
    static async getAssessmentTrajectory(userId: number, type: AssessmentType, limit = 24) {
        // Newest first, then reversed.
        //
        // The previous query was `orderBy: { createdAt: "asc" }, take: limit`. MySQL
        // applies LIMIT *after* ORDER BY, so the window was the *beginning* of the
        // screening history: once a patient had more than `limit` sittings, the
        // oldest ones were kept and the newest discarded.
        //
        // That is a clinical bug, not a display one. `summary.latest` is rendered
        // by the client as "Latest score", and `summary.direction` as the
        // improving / stable / worsening verdict - so a patient whose PHQ-9 had
        // risen sharply was shown a permanently frozen verdict derived from their
        // *earliest* sittings, while `GET /api/wellness/assessments` on the very
        // same screen showed the real current score.
        //
        // Taking the newest N and reversing gives ascending order for the
        // `changeFromPrevious` arithmetic below while keeping the window anchored
        // to the present. `getAssessments` at line 362 already ordered `desc` for
        // exactly this reason.
        const newest = await prisma.assessment.findMany({
            where: { userId, type },
            orderBy: { createdAt: "desc" },
            take: Math.min(limit, 100),
            select: { id: true, score: true, severity: true, createdAt: true },
        });
        const rows = [...newest].reverse();

        const points = rows.map((row, i) => ({
            id: row.id,
            score: row.score,
            severity: row.severity,
            createdAt: row.createdAt,
            // Negative means the score fell, which is the direction these scales
            // move in when symptoms ease. Named rather than left as a signed
            // number so a client cannot render it as an increase in severity.
            changeFromPrevious: i === 0 ? null : row.score - rows[i - 1].score,
        }));

        const first = points[0]?.score ?? null;
        const last = points[points.length - 1]?.score ?? null;
        const totalChange = first !== null && last !== null ? last - first : null;

        return {
            type,
            instrument: INSTRUMENTS[type],
            points,
            summary: {
                sittings: points.length,
                first,
                latest: last,
                totalChange,
                // Null rather than "stable" when there is not enough data. A
                // single sitting is not a trend, and calling it stable would be
                // a claim about a person made from one data point.
                direction: describeDirection(totalChange, points.length),
            },
        };
    }

    static async getLatestAssessments(userId: number) {
        const [phq9, gad7] = await Promise.all([
            prisma.assessment.findFirst({ where: { userId, type: "phq9" }, orderBy: { createdAt: "desc" } }),
            prisma.assessment.findFirst({ where: { userId, type: "gad7" }, orderBy: { createdAt: "desc" } }),
        ]);
        return [phq9, gad7].filter(Boolean).map((a) => ({
            type: a!.type,
            score: a!.score,
            severity: a!.severity,
            createdAt: a!.createdAt,
        }));
    }
}
