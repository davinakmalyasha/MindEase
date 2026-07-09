import { z } from "zod";

export const CreateReviewSchema = z.object({
    body: z.object({
        doctorId: z.number().int().positive("Doctor is required"),
        appointmentId: z.number().int().positive("Appointment is required"),
        rating: z.number().int().min(1).max(5, "Rating must be between 1 and 5"),
        comment: z.string().min(3, "Comment must be at least 3 characters").max(2000, "Comment too long"),
    }),
});

export const LogMoodSchema = z.object({
    body: z.object({
        mood: z.number().int().min(1).max(5, "Mood must be between 1 and 5"),
        notes: z.string().max(1000, "Notes must be under 1000 characters").optional(),
    }),
});

export const MoodHistorySchema = z.object({
    query: z.object({
        days: z.string().regex(/^\d+$/).optional(),
    }),
});
