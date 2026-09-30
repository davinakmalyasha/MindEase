import { z } from "zod";

const MOOD_FACTORS = ["sleep", "exercise", "social", "work", "stress"] as const;

export const CreateReviewSchema = z.object({
    body: z.object({
        doctorId: z.coerce.number().int().positive("Doctor is required"),
        appointmentId: z.coerce.number().int().positive("Appointment is required"),
        rating: z.number().int().min(1).max(5, "Rating must be between 1 and 5"),
        comment: z.string().min(3, "Comment must be at least 3 characters").max(2000, "Comment too long"),
    }),
});

export const LogMoodSchema = z.object({
    body: z
        .object({
            mood: z.coerce.number().int().min(1).max(5, "Mood must be between 1 and 5"),
            notes: z.string().max(1000, "Notes must be under 1000 characters").optional(),
            factors: z.array(z.enum(MOOD_FACTORS)).max(5, "Too many factors").optional(),
        })
        .strict(),
});

export const JournalEntrySchema = z.object({
    body: z
        .object({
            content: z
                .string()
                .min(3, "Journal entry must be at least 3 characters")
                .max(10000, "Journal entry too long"),
        })
        .strict(),
});

export const JournalListSchema = z.object({
    query: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
});

/**
 * The inner shape of a MySQL INT primary key path parameter. Rejects `NaN`,
 * zero, negatives and junk strings — previously these reached Prisma as `NaN`
 * and surfaced as a 500 carrying an internal error string.
 */
import { idObject, idParam } from "./params.schema";

// Re-exported so existing imports keep working; the definitions now live in one
// place rather than being duplicated per schema file.
export { idObject, idParam };

/**
 * `days` is bounded. It was previously an unconstrained numeric string, so
 * `?days=99999999` produced an Invalid Date and a 500, and a large value
 * returned the user's entire history with no limit.
 */
export const MoodHistorySchema = z.object({
    query: z.object({
        days: z.coerce.number().int().min(1, "days must be at least 1").max(365, "days must be 365 or fewer").optional(),
    }),
});

export const MoodStatsSchema = z.object({
    query: z.object({
        days: z.coerce.number().int().min(1).max(365).optional(),
    }),
});

export const JournalIdSchema = idParam;

export const JournalSummarizeSchema = z.object({
    body: z
        .object({
            entryId: z.coerce.number().int().positive().optional(),
        })
        .strict(),
});

export const SubmitAssessmentSchema = z.object({
    body: z
        .object({
            type: z.enum(["phq9", "gad7"], { message: "Assessment type must be phq9 or gad7" }),
            // Exactly the instrument's question count; the service re-checks and
            // is the authority, but bounding the array here keeps a hostile
            // client from submitting thousands of values.
            answers: z
                .array(z.number().int().min(0).max(3), { message: "Answers must be integers 0-3" })
                .min(1)
                .max(9),
        })
        .strict(),
});

export const AssessmentListSchema = z.object({
    query: z.object({
        type: z.enum(["phq9", "gad7"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
});

export const ReplyReviewSchema = z.object({
    body: z.object({
        reply: z.string().min(1, "Reply cannot be empty").max(2000, "Reply too long"),
    }),
});

export const ReportReviewSchema = z.object({
    body: z.object({
        reason: z.string().min(5, "Please describe the issue").max(2000, "Reason too long"),
    }),
});
