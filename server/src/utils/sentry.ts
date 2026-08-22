import * as Sentry from "@sentry/node";

/**
 * Initializes Sentry when SENTRY_DSN is configured. No-op otherwise, so local
 * development and CI are unaffected.
 */
export const initSentry = () => {
    if (!process.env.SENTRY_DSN) return false;
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || "development",
        release: process.env.SENTRY_RELEASE,
        tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
            ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
            : 0.1,
        maxBreadcrumbs: 50,
    });
    return true;
};

export const captureError = (error: unknown, context?: Record<string, unknown>) => {
    if (!process.env.SENTRY_DSN) return;
    Sentry.captureException(error, { extra: context });
};
