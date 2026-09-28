/**
 * A failure whose message is safe to show a client.
 *
 * Anything thrown as a plain `Error` is treated as internal: its message may
 * contain a Prisma invocation with model and column names, the offending
 * argument, or a file path, and echoing that to an anonymous caller hands out
 * the shape of the database and turns a malformed request into a
 * schema-fingerprinting oracle.
 */
export class AppError extends Error {
    readonly status: number;
    /** Extra machine-readable context, e.g. `{ code: "TOTP_REQUIRED" }`. */
    readonly details?: Record<string, unknown>;

    constructor(
        message: string,
        status = 400,
        details?: Record<string, unknown>
    ) {
        super(message);
        this.name = "AppError";
        this.status = status;
        this.details = details;
    }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
    new AppError(message, 400, details);
export const unauthorized = (message = "Unauthorized") => new AppError(message, 401);
export const forbidden = (message = "Forbidden") => new AppError(message, 403);
export const notFound = (message = "Not found") => new AppError(message, 404);
export const conflict = (message: string) => new AppError(message, 409);

/** Throws `AppError(404)` unless `condition` holds. */
export const assertFound = <T>(value: T | null | undefined, message = "Not found"): T => {
    if (value === null || value === undefined) throw notFound(message);
    return value;
};

/**
 * Patterns that identify a message as *internal* — produced by the database
 * driver, the ORM, the filesystem or the module loader — rather than written by
 * a human for a user to read.
 *
 * This is the important design decision: in this codebase, services throw
 * human-readable business messages ("This doctor is not accepting bookings yet",
 * "Package session is not available", "This time is already booked for that
 * doctor"). Those are the intended API contract and are shown to callers.
 * The actual leak risk is specifically ORM and driver text, which names models,
 * columns, constraint names and the offending argument — so suppression is keyed
 * on that, not on a phrase allowlist that would have to enumerate every
 * business message and would silently hide new ones.
 */
const INTERNAL_PATTERNS = [
    "prisma",
    "invocation",
    "unique constraint",
    "foreign key",
    "econnrefused",
    "econnreset",
    "etimedout",
    "getaddrinfo",
    "enotfound",
    "node_modules",
    "at object.",
    "at module.",
    "at async",
];

/** SQL keywords, matched case-sensitively so "Update your preferences" survives. */
const SQL_STATEMENT = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/;

/** Long messages are almost certainly a dump rather than a sentence. */
const MAX_PUBLIC_MESSAGE_LENGTH = 200;

/** Characters that suggest a path, a query or a raw identifier. */
const SUSPICIOUS = /[{}<>]|\b[a-z]+[A-Z][a-z]+\(/;

const statusFor = (message: string): number => {
    const lower = message.toLowerCase();
    if (lower.includes("forbidden") || lower.includes("not a participant")) return 403;
    if (lower.includes("unauthorized")) return 401;
    if (lower.includes("not found")) return 404;
    if (lower.includes("already")) return 409;
    return 400;
};

/**
 * Decides what a client is allowed to see about a thrown error.
 *
 * Returns `null` for anything that should be reported as a generic failure.
 */
export const publicMessageFor = (
    error: unknown
): { message: string; status: number; details?: Record<string, unknown> } | null => {
    if (error instanceof AppError) {
        return { message: error.message, status: error.status, details: error.details };
    }

    if (!(error instanceof Error)) return null;

    const message = (error.message || "").trim();

    // No message, a multi-line message, or anything that looks like a dump.
    // A message that embeds a trace is caught here by the newline test — the
    // `stack` property itself cannot be used as a signal, because it is present
    // on every `Error` including a hand-written business message.
    if (!message) return null;
    if (message.includes("\n")) return null;
    if (message.length > MAX_PUBLIC_MESSAGE_LENGTH) return null;
    if (SUSPICIOUS.test(message)) return null;

    const lower = message.toLowerCase();
    if (INTERNAL_PATTERNS.some((needle) => lower.includes(needle))) return null;
    if (SQL_STATEMENT.test(message)) return null;

    return { message, status: statusFor(message) };
};
