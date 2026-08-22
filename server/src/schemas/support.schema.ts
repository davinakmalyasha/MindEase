import { z } from "zod";

export const SupportChatSchema = z.object({
    body: z.object({
        message: z.string().min(1, "Message is required").max(2000, "Message too long"),
        history: z
            .array(
                z.object({
                    role: z.enum(["user", "assistant"]),
                    content: z.string().max(2000),
                })
            )
            .max(20)
            .optional(),
    }),
});
