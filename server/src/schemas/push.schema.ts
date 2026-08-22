import { z } from "zod";

export const PushSubscribeSchema = z.object({
    body: z.object({
        endpoint: z.string().min(10, "Invalid endpoint"),
        keys: z.object({
            p256dh: z.string().min(10),
            auth: z.string().min(5),
        }),
    }),
});
