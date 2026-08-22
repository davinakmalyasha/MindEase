import { z } from "zod";

export const CreateReviewSchema = z.object({
    body: z.object({
        doctorId: z.number().int().positive("Doctor is required"),
        appointmentId: z.number().int().positive("Appointment is required"),
        rating: z.number().int().min(1).max(5, "Rating must be between 1 and 5"),
        comment: z.string().min(3, "Comment must be at least 3 characters").max(2000, "Comment too long"),
    }),
});

const MOOD_FACTORS = ["sleep", "exercise", "social", "work", "stress"] as const;

export const LogMoodSchema = z.object({
    body: z.object({
        mood: z.number().int().min(1).max(5, "Mood must be between 1 and 5"),
        notes: z.string().max(1000, "Notes must be under 1000 characters").optional(),
        factors: z.array(z.enum(MOOD_FACTORS)).max(5, "Too many factors").optional(),
    }),
});

export const MoodHistorySchema = z.object({
    query: z.object({
        days: z.string().regex(/^\d+$/).optional(),
    }),
});

export const JournalEntrySchema = z.object({
    body: z.object({
        content: z.string().min(3, "Journal entry must be at least 3 characters").max(10000, "Journal entry too long"),
    }),
});

export const JournalListSchema = z.object({
    query: z.object({
        limit: z.string().regex(/^\d+$/).optional(),
    }),
});

export const SubmitAssessmentSchema = z.object({
    body: z.object({
        type: z.enum(["phq9", "gad7"], { message: "Assessment type must be phq9 or gad7" }),
        answers: z.array(z.number().int().min(0).max(3), { message: "Answers must be integers 0-3" }),
    }),
});

export const AssessmentListSchema = z.object({
    query: z.object({
        type: z.enum(["phq9", "gad7"]).optional(),
        limit: z.string().regex(/^\d+$/).optional(),
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
