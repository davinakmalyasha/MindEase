// Global setup: point the app at the test database before anything is imported.
const testDbUrl = process.env.TEST_DATABASE_URL || "mysql://root:@127.0.0.1:3306/mindease_test";
process.env.DATABASE_URL = testDbUrl;
process.env.JWT_SECRET = "test-jwt-secret-value-0001";
process.env.REFRESH_SECRET = "test-refresh-secret-0001";
// Deliberately distinct, so the suite exercises the real separation rather
// than the development fallback.
process.env.TWO_FACTOR_SECRET = "test-two-factor-secret-0001";
process.env.NODE_ENV = "test";

export default async function globalSetup() {
    // No-op — schema push is handled by the test:db script.
    // Keeping the hook ensures vitest uses an isolated process for setup.
}
