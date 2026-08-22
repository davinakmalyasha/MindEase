import { z } from "zod";

export const SendMessageSchema = z.object({
    body: z.object({
        content: z.string().max(4000, "Message too long").optional().default(""),
        attachment: z
            .object({
                url: z.string().max(500),
                type: z.enum(["image", "file"]),
            })
            .optional(),
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

export const TypingSchema = z.object({
    params: z.object({
        userId: z.string().regex(/^\d+$/, "Invalid user id"),
    }),
    body: z.object({
        isTyping: z.boolean(),
    }),
});

export const MarkReadSchema = z.object({
    params: z.object({
        userId: z.string().regex(/^\d+$/, "Invalid user id"),
    }),
});
