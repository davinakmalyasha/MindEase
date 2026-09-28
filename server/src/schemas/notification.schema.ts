import { z } from "zod";

const ChannelPrefsSchema = z.object({
    inApp: z.boolean().optional(),
    email: z.boolean().optional(),
});

/**
 * Accepts both the per-channel object shape and the legacy flat boolean, which
 * older clients still send. Rejecting the boolean outright broke those clients
 * with a 400 the moment the object shape was introduced.
 */
const LegacyOrChannel = z.union([z.boolean(), ChannelPrefsSchema]);

export const NotificationPrefsSchema = z.object({
    body: z
        .object({
            appointment: LegacyOrChannel.optional(),
            message: LegacyOrChannel.optional(),
            system: LegacyOrChannel.optional(),
        })
        .strict(),
});
