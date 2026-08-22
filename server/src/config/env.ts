/**
 * Centralized environment configuration with fail-fast validation.
 *
 * In production, missing or known-weak secrets abort the boot process
 * instead of silently falling back to insecure defaults.
 */

const isProd = process.env.NODE_ENV === "production";

const KNOWN_WEAK = new Set(["supersecret", "superrefreshsecret", "changeme", "secret", "password"]);

function requireSecret(name: string, devFallback: string): string {
    const value = process.env[name];
    if (!value || value.trim() === "") {
        if (isProd) {
            throw new Error(`[config] Missing required environment variable: ${name}. Refusing to start in production.`);
        }
        return devFallback;
    }
    if (isProd && KNOWN_WEAK.has(value.toLowerCase())) {
        throw new Error(`[config] ${name} is set to a known weak default value. Refusing to start in production.`);
    }
    if (value.length < 16) {
        if (isProd) {
            throw new Error(`[config] ${name} must be at least 16 characters long. Refusing to start in production.`);
        }
    }
    return value;
}

export const env = {
    isProd,
    isTest: process.env.NODE_ENV === "test",

    jwtSecret: requireSecret("JWT_SECRET", "dev_only_insecure_jwt_secret_change_me"),
    refreshSecret: requireSecret("REFRESH_SECRET", "dev_only_insecure_refresh_secret_change_me"),

    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    redisUrl: process.env.REDIS_URL || "",
    frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
    port: Number(process.env.PORT || 5000),

    /** Allowed browser origins for CORS (comma-separated). Falls back to FRONTEND_URL. */
    corsOrigins: (process.env.CORS_ORIGINS || "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
        .concat([process.env.FRONTEND_URL || "http://localhost:3000"]),
};
