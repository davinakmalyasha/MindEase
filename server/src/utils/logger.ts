import pino from "pino";

/**
 * Structured application logger.
 *
 * `redact` is not optional here. This service handles mental-health data:
 * journal entries, screening scores, therapy notes, TOTP seeds and session
 * tokens all pass through code that logs. Without redaction, a single
 * `logger.info({ req })` in future code writes a patient's credentials and
 * clinical content to Railway's log store in cleartext, where it is retained,
 * searchable, and readable by anyone with dashboard access.
 *
 * The paths below cover the request-shaped and model-shaped locations that
 * would be logged by accident. Anything new that touches a secret must be added
 * here as part of the change that introduces it.
 */
export const logger = pino({
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
        paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "res.headers['set-cookie']",
            "*.password",
            "*.newPassword",
            "*.currentPassword",
            "*.token",
            "*.accessToken",
            "*.refreshToken",
            "*.twoFactorToken",
            "*.otp",
            "*.totpSecret",
            "*.resetOtpHash",
            "*.verifyOtpHash",
            "*.backupCodes",
            "*.secret",
            "*.apiKey",
            "*.api_key",
            "*.smtpPass",
            "*.authorization",
            "*.bankAccount",
            "*.notes",
            "*.content",
            "*.answersJson",
            "*.briefingText",
        ],
        censor: "[redacted]",
    },
});
