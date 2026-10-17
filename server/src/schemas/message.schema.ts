import { z } from "zod";
import { uuid7 } from "./params.schema";

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
    .refine((v) => isPlatformAttachment(v), {
        message: "Attachment must reference a file uploaded through this platform",
    });

/** Hosts this deployment may serve uploads from. Empty means "not configured". */
const configuredUploadHosts = (): string[] => {
    const base = (process.env.S3_PUBLIC_URL || "").trim();
    if (!base) return [];
    try {
        const host = new URL(base).host.toLowerCase();
        return host ? [host] : [];
    } catch {
        return [];
    }
};

/**
 * True for a URL this deployment could itself have produced.
 *
 * The previous regex was `/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/avatars\//i`, which
 * read as a host restriction and was not one:
 *
 *   - `[^/]+` accepts any host, so `https://evil.example/avatars/pixel.png`
 *     passed. That is the tracking-pixel and phishing case the file header
 *     describes as closed.
 *   - the scheme class accepts any RFC 3986 scheme and `[^/]+` matches a
 *     newline, so `javascript://\nalert(document.cookie)/avatars/g;` matched.
 *     `//` opens a JavaScript line comment and `/avatars/g` is a valid regex
 *     literal. That reaches an `<a href>` in the clinician's browser.
 *
 * Both branches are now explicit. A local upload is a path this server serves
 * itself. A remote one must be https, must sit under the configured S3 public
 * base, and must therefore carry that base's exact host.
 */
function isPlatformAttachment(value: string): boolean {
    if (value.startsWith("/uploads/")) {
        // A path this server serves. Reject anything that could escape it or
        // smuggle a scheme: no traversal, no backslashes, no control characters.
        //
        // `no-control-regex` is disabled here because matching control
        // characters is the entire purpose of this test: a URL with a NUL or a
        // newline in it is the thing being rejected. The rule exists to catch
        // control characters that arrived by accident, which is a different
        // problem, and in this file it had already happened once - the
        // character class was written as `[<NUL>-<0x1F>\s]` with literal control
        // bytes in the source, because an escape sequence had been interpreted
        // somewhere. `scripts/check-encoding.js` now fails on that, so the two
        // checks cover the two ways of writing this.
        // eslint-disable-next-line no-control-regex
        if (value.includes("..") || value.includes("\\") || /[\x00-\x1F\s]/.test(value)) return false;
        return true;
    }

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }

    // A relative or non-absolute URL cannot be parsed, and anything that parsed
    // but is not https is not something the S3 SDK produced.
    if (url.protocol !== "https:") return false;

    const hosts = configuredUploadHosts();
    if (hosts.length === 0) return false;

    return (
        hosts.includes(url.host.toLowerCase()) &&
        url.pathname.toLowerCase().includes("/avatars/")
    );
}

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
        userId: uuid7,
    }),
});

export const GetMessagesSchema = z.object({
    params: z.object({
        userId: uuid7,
    }),
    query: z.object({
        limit: z.string().regex(/^\d+$/).optional(),
        before: uuid7.optional(),
    }),
});

export const TypingSchema = z.object({
    params: z.object({
        userId: uuid7,
    }),
    body: z.object({
        isTyping: z.boolean(),
    }),
});

export const MarkReadSchema = z.object({
    params: z.object({
        userId: uuid7,
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
        id: uuid7,
    }),
    body: z.object({
        reaction: z
            .union([z.enum(REACTIONS), z.null()])
            .describe("An allowlisted emoji, or null to clear"),
    }),
});

export const MessageIdSchema = z.object({
    params: z.object({
        id: uuid7,
    }),
});
