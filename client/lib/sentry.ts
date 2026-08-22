"use client";

import * as Sentry from "@sentry/browser";

let initialized = false;

/**
 * Lazy client-side Sentry init. No-op when NEXT_PUBLIC_SENTRY_DSN is unset,
 * so local development is unaffected.
 */
export function initClientSentry() {
    if (initialized) return;
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (!dsn) return;
    Sentry.init({
        dsn,
        environment: process.env.NODE_ENV || "development",
        release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
        tracesSampleRate: 0.1,
    });
    initialized = true;
}

export function captureClientError(error: unknown, context?: Record<string, unknown>) {
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
    Sentry.captureException(error, { extra: context });
}
