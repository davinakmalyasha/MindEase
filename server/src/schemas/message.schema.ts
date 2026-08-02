import { z } from "zod";

export const SendMessageSchema = z.object({
    body: z.object({
        content: z.string().min(1, "Message cannot be empty").max(4000, "Message too long"),
    }),
    params: z.object({
        userId: z.string().regex(/^\d+$/, "Invalid user id"),
    }),
});

export const GetMessagesSchema = z.object({
    params: z.object({
        userId: z.string().regex(/^\d+$/, "Invalid user id"),
    }),
    query: z.object({
        limit: z.string().regex(/^\d+$/).optional(),
        before: z.string().regex(/^\d+$/).optional(),
    }),
});

export const MarkReadSchema = z.object({
    params: z.object({
        userId: z.string().regex(/^\d+$/, "Invalid user id"),
    }),
});
