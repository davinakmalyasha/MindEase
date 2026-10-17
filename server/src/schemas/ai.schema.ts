import { z } from "zod";
import { uuid7 } from "./params.schema";

export const GenerateQuestionsSchema = z.object({
    body: z.object({
        appointmentId: uuid7,
    }),
});

export const SubmitAnswersSchema = z.object({
    body: z.object({
        appointmentId: uuid7,
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
        appointmentId: uuid7,
    }),
    params: z.object({
        appointmentId: uuid7.optional(),
    }),
});

export const MatchDoctorsSchema = z.object({
    body: z.object({
        query: z.string().min(3, "Describe what you're looking for (min. 3 characters)").max(300),
    }),
});

