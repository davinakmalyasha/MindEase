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

/**
 * `Message.reaction` is a single column. This route had no schema at all, so
 * `req.body.reaction` went from JSON straight into that column — an unbounded
 * string, of any content, from any participant.
 *
 * The set is a closed allowlist rather than an emoji regex: a "reaction" here
 * is a UI affordance with a fixed set of buttons, so anything else is a client
 * bug or an attempt to write arbitrary data. `null` clears the reaction.
 */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

export const ReactionSchema = z.object({
    params: z.object({
        id: z.string().regex(/^\d+$/, "Invalid message id"),
    }),
    body: z.object({
        reaction: z
            .union([z.enum(REACTIONS), z.null()])
            .describe("An allowlisted emoji, or null to clear"),
    }),
});

export const MessageIdSchema = z.object({
    params: z.object({
        id: z.string().regex(/^\d+$/, "Invalid message id"),
    }),
});
