import { z } from "zod";
import { idObject } from "./params.schema";

/**
 * Care plan and safety plan input.
 *
 * Every field is optional and nullable. A care plan and a safety plan are both
 * filled in gradually, over months, and a schema that required all sections
 * would mean the document could never be saved until it was already complete -
 * which is the point at which nobody needs it.
 *
 * Lengths are generous but bounded. These are the two free-text surfaces in the
 * product, and an unbounded box on a crisis document is an invitation to paste
 * something nobody has read.
 */

const section = (max: number) => z.string().max(max, "Section too long").nullable().optional();

/**
 * An ISO date that also exists on a calendar.
 *
 * The shape regex alone is not enough, and both failure modes it allows are
 * real. `"2026-13-45"` matched the pattern, `new Date(...)` produced an Invalid
 * Date, Prisma threw, and a client error was answered with a 500. Worse,
 * `"2026-02-31"` matched, and JavaScript rolled it forward to 3 March - so a
 * target date was silently stored two days late, on a document a clinician
 * reviews.
 *
 * The round trip is the check: parse it, and require the date part to come back
 * unchanged.
 */
const dateOrNull = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, "Expected an ISO date")
    .refine((value) => {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return false;
        // Compare only the calendar part, so a timezone suffix cannot make a
        // legitimate date fail on a DST boundary.
        return value.slice(0, 10) === d.toISOString().slice(0, 10);
    }, "Not a real calendar date")
    .nullable()
    .optional();

export const UpdateCarePlanSchema = z.object({
    body: z
        .object({
            title: z.string().min(1).max(160).optional(),
            summary: section(4000),
            status: z.enum(["active", "completed", "paused"]).optional(),
            reviewAt: dateOrNull,
        })
        .strict(),
    params: idObject,
});

export const CreateGoalSchema = z.object({
    body: z
        .object({
            title: z.string().min(1, "Give the goal a title").max(200),
            detail: section(2000),
            targetDate: dateOrNull,
        })
        .strict(),
    params: idObject,
});

export const UpdateGoalSchema = z.object({
    body: z
        .object({
            title: z.string().min(1).max(200).optional(),
            detail: section(2000),
            // `dropped` is accepted alongside `achieved` on purpose. A goal
            // abandoned because it was wrong has to be distinguishable from one
            // that was met, or the plan overstates its own progress.
            status: z.enum(["open", "in_progress", "achieved", "paused", "dropped"]).optional(),
            targetDate: dateOrNull,
        })
        .strict(),
    params: idObject,
});

export const CreateStepSchema = z.object({
    body: z.object({ title: z.string().min(1, "Give the step a title").max(200) }).strict(),
    params: idObject,
});

export const SetStepDoneSchema = z.object({
    body: z.object({ done: z.boolean() }).strict(),
    params: idObject,
});

export const SaveSafetyPlanSchema = z.object({
    body: z
        .object({
            warningSigns: section(4000),
            copingStrategies: section(4000),
            reasonsToLive: section(4000),
            // A JSON array of { name, phone, relationship }. Validated as a
            // string here rather than parsed, because the service stores it
            // verbatim and the client owns the shape - but the length is
            // bounded, since this is a short list of people rather than a
            // document.
            contacts: section(2000),
            professionalContact: z.string().max(255).nullable().optional(),
            locationToBeSafe: z.string().max(255).nullable().optional(),
        })
        .strict(),
});
