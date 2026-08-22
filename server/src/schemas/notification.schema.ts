import { z } from "zod";

const ChannelPrefsSchema = z.object({
    inApp: z.boolean().optional(),
    email: z.boolean().optional(),
});

export const NotificationPrefsSchema = z.object({
    body: z.object({
        appointment: ChannelPrefsSchema.optional(),
        message: ChannelPrefsSchema.optional(),
        system: ChannelPrefsSchema.optional(),
    }),
});
