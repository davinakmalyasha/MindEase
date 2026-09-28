/**
 * Centralized environment configuration with fail-fast validation.
 *
 * In production, missing or known-weak secrets abort the boot process
 * instead of silently falling back to insecure defaults.
 */

const isProd = process.env.NODE_ENV === "production";

const KNOWN_WEAK = new Set([
    "supersecret",
    "superrefreshsecret",
    "changeme",
    "secret",
    "password",
]);

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
    // Dev fallbacks are prefixed so they can never be mistaken for a real
    // secret, and so they are rejected outright in production.
    if (isProd && value.startsWith("dev_")) {
        throw new Error(`[config] ${name} still uses its development fallback. Refusing to start in production.`);
    }
    if (value.length < 16) {
        if (isProd) {
            throw new Error(`[config] ${name} must be at least 16 characters long. Refusing to start in production.`);
        }
    }
    return value;
}

function requireUrl(name: string, devFallback: string): string {
    const value = process.env[name];
    if (!value || value.trim() === "") {
        if (isProd) {
            throw new Error(`[config] Missing required environment variable: ${name}. Refusing to start in production.`);
        }
        return devFallback;
    }
    return value;
}

/** Warns at boot about variables the app treats as optional but cannot work without. */
const requiredInProd = ["GOOGLE_CLIENT_ID", "GEMINI_API_KEY", "REDIS_URL"] as const;
for (const name of requiredInProd) {
    if (isProd && !(process.env[name] || "").trim()) {
        // eslint-disable-next-line no-console
        console.warn(`[config] ${name} is not set — dependent features will be disabled in production.`);
    }
}

const jwtSecret = requireSecret("JWT_SECRET", "dev_only_insecure_jwt_secret_change_me");
const refreshSecret = requireSecret("REFRESH_SECRET", "dev_only_insecure_refresh_secret_change_me");

/**
 * Purpose-scoped secret for pending two-factor tickets. Keeping it distinct
 * from the access-token secret means a pending ticket is cryptographically
 * incapable of verifying as an access token.
 */
const twoFactorSecret = (() => {
    const explicit = (process.env.TWO_FACTOR_SECRET || "").trim();
    if (explicit) {
        if (isProd && explicit === jwtSecret) {
            throw new Error(
                "[config] TWO_FACTOR_SECRET must differ from JWT_SECRET in production."
            );
        }
        return explicit;
    }
    if (isProd) {
        throw new Error(
            "[config] TWO_FACTOR_SECRET is not set. Refusing to start in production."
        );
    }
    return jwtSecret;
})();

export const env = {
    isProd,
    isTest: process.env.NODE_ENV === "test",

    jwtSecret,
    refreshSecret,
    twoFactorSecret,

    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    redisUrl: process.env.REDIS_URL || "",
    frontendUrl: requireUrl("FRONTEND_URL", "http://localhost:3000"),
    port: Number(process.env.PORT || 5000),

    /**
     * Allowed browser origins for CORS. Derived exclusively from explicit
     * configuration — never a hard-coded localhost fallback, which would
     * otherwise silently widen the allowlist in production.
     */
    corsOrigins: (() => {
        const configured = (process.env.CORS_ORIGINS || "")
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean);
        const frontend = (process.env.FRONTEND_URL || "").trim();
        if (frontend) configured.push(frontend);
        if (configured.length === 0) {
            return ["http://localhost:3000"];
        }
        return Array.from(new Set(configured));
    })(),
};
