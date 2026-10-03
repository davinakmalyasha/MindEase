// Global setup: point the app at the test database before anything is imported.
//
// This file is the ONLY place environment configuration reaches the suite.
// `tests/setup.ts` also sets these, but its assignments are dead: it imports
// `../src/app`, ESM hoists that import above every statement in the file, and
// `config/env.ts` captures process.env at module evaluation. Because
// `globalSetup` runs in Vitest's main process before any worker is forked, the
// values set here are the ones the workers inherit. The comment in setup.ts
// saying the opposite is what cost an afternoon.
const testDbUrl = process.env.TEST_DATABASE_URL || "mysql://root:@127.0.0.1:3306/mindease_test";
process.env.DATABASE_URL = testDbUrl;
process.env.JWT_SECRET = "test-jwt-secret-value-0001";
process.env.REFRESH_SECRET = "test-refresh-secret-0001";
// Deliberately distinct, so the suite exercises the real separation rather
// than the development fallback.
process.env.TWO_FACTOR_SECRET = "test-two-factor-secret-0001";
process.env.NODE_ENV = "test";

// Video is configured the way production is: livekit with real credentials
// present. The previous default was the jitsi fallback, which meant the token
// minting path - the one that actually secures a consultation - was never
// exercised by a single test, and `video-token.test.ts` failed all twelve of
// its cases against an empty API secret. The jitsi fallback is still covered,
// by `video-fallback.test.ts`, which overrides this deliberately.
process.env.VIDEO_PROVIDER = "livekit";
process.env.LIVEKIT_URL = "wss://livekit.example.com";
process.env.LIVEKIT_API_KEY = "APItestkey";
process.env.LIVEKIT_API_SECRET = "test-livekit-secret-value-0000";

export default async function globalSetup() {
    // No-op. The schema is built by `prisma migrate deploy` (or the
    // `npm run test:db` script) before the suite starts, and
    // `tests/setup.ts` wipes every table between tests. Keeping the hook
    // ensures Vitest uses an isolated process for setup.
}
