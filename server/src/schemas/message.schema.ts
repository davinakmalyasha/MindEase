import { z } from "zod";

/**
 * An attachment must reference a file this deployment actually issued.
 *
 * This was `z.string().max(500)` with no format or host restriction, and the
 * value was stored verbatim and returned to the *counterpart*. So a patient
 * with a confirmed appointment could send
 * `{content:"", attachment:{url:"https://evil.example/session-expired",
 * type:"file"}}` and the clinician's client would render an
 * attacker-controlled remote URL: a phishing page impersonating the platform,
 * or a tracking pixel confirming the clinician opened the message.
 *
 * Both prefixes are what `lib/storage.ts` actually produces - a local
 * `/uploads/<key>` path, or an S3 URL under the configured public base - so
 * requiring one of them costs nothing legitimate and removes the entire class.
 * Length is kept as a backstop for a pathological S3 base URL.
 */
const attachmentUrl = z
    .string()
    .max(500)
    .refine(
        (v) =>
            v.startsWith("/uploads/") ||
            /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/avatars\//i.test(v),
        "Attachment must reference a file uploaded through this platform"
    );

export const SendMessageSchema = z.object({
    body: z.object({
        content: z.string().max(4000, "Message too long").optional().default(""),
        attachment: z
            .object({
                url: attachmentUrl,
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
