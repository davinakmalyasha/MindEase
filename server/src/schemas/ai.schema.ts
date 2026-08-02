import { z } from "zod";

export const GenerateQuestionsSchema = z.object({
    body: z.object({
        appointmentId: z.number().int().positive("Appointment is required"),
    }),
});

export const SubmitAnswersSchema = z.object({
    body: z.object({
        appointmentId: z.number().int().positive("Appointment is required"),
        answers: z
            .array(
                z.object({
                    question: z.string().min(1, "Question is required"),
                    answer: z.string().min(1, "Answer is required"),
                })
            )
            .min(1, "At least one answer is required")
            .max(10, "Too many answers"),
    }),
});

export const GenerateBriefingSchema = z.object({
    body: z.object({
        appointmentId: z.number().int().positive("Appointment is required"),
    }),
    params: z.object({
        appointmentId: z.string().optional(),
    }),
});
