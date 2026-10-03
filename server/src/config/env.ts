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

/**
 * Warns at boot about variables the app treats as optional but cannot work
 * without in a production topology.
 *
 * `GOOGLE_CLIENT_ID` and `GEMINI_API_KEY` degrade a feature. `REDIS_URL` costs
 * realtime pub/sub and the shared rate-limit counters. The S3 group is
 * different in kind and is called out separately below, because its failure
 * mode is data loss rather than a missing feature.
 */
const requiredInProd = ["GOOGLE_CLIENT_ID", "GEMINI_API_KEY", "REDIS_URL"] as const;
for (const name of requiredInProd) {
    if (isProd && !(process.env[name] || "").trim()) {
        console.warn(
            `[config] ${name} is not set - dependent features will be disabled in production.`
        );
    }
}

/**
 * S3, when unset in production, is not a degraded feature.
 *
 * `lib/storage.ts` falls back to the container's local disk whenever the S3
 * variables are missing, and `docker-compose.yml` mounts a named volume there,
 * so a single-container deployment is fine. A multi-replica deployment is not:
 * an avatar uploaded to replica A 404s on replica B, and everything is lost on
 * the next deploy, because `Dockerfile` creates `public/uploads` with no
 * `VOLUME` and no way to persist it across replicas. `deleteFile` then
 * silently no-ops, so the directory grows without bound.
 *
 * This warns rather than throws, unlike the payments and 2FA validators, for
 * one reason: `docker-compose.yml` sets `NODE_ENV: production` and has no S3,
 * and that is the documented way to run the project locally. Failing to boot
 * there would be worse than the warning.
 */
const S3_VARS = [
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
] as const;
if (isProd && S3_VARS.some((n) => !(process.env[n] || "").trim())) {
    console.warn(
        "[config] S3 storage is not configured. Avatars and chat attachments will be written to the " +
            "container's local disk. That is fine for the single-container docker-compose stack, which " +
            "mounts a volume, but on more than one replica an upload to one instance is a 404 on the " +
            "next and every file is lost on redeploy. Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and " +
            "S3_SECRET_KEY before scaling past one instance."
    );
}

const jwtSecret = requireSecret("JWT_SECRET", "dev_only_insecure_jwt_secret_change_me");
const refreshSecret = requireSecret("REFRESH_SECRET", "dev_only_insecure_refresh_secret_change_me");

// A refresh token is the longest-lived credential in the system (7 days). If it
// shared a secret with the access token it could be presented to any endpoint
// that verifies an access token — including the realtime WebSocket, where it
// would become a 7-day session. Two-factor was already checked for this; refresh
// was not, and copy-pasting one value into both is the obvious operator mistake.
if (isProd && refreshSecret === jwtSecret) {
    throw new Error(
        "[config] REFRESH_SECRET must differ from JWT_SECRET in production."
    );
}

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

    /**
     * AI call resilience.
     *
     * `requestTimeoutMs` bounds a single Gemini call. Without it the SDK waits
     * out its own default, during which the Express handler stays open and the
     * caller is left staring at a spinner.
     *
     * The breaker stops every request from paying that timeout while the
     * dependency is down: after `circuitThreshold` consecutive failures the
     * circuit opens for `circuitCooldownMs` and calls short-circuit to their
     * local fallback instead of hammering a struggling upstream.
     *
     * A non-numeric or non-positive value falls back to the default rather than
     * disabling the protection, mirroring the realtime service's connection caps.
     */
    ai: (() => {
        const positiveInt = (name: string, fallback: number) => {
            const raw = (process.env[name] || "").trim();
            if (!raw) return fallback;
            const n = Number.parseInt(raw, 10);
            return Number.isFinite(n) && n > 0 ? n : fallback;
        };
        return {
            requestTimeoutMs: positiveInt("AI_REQUEST_TIMEOUT_MS", 20_000),
            circuitThreshold: positiveInt("AI_CIRCUIT_THRESHOLD", 5),
            circuitCooldownMs: positiveInt("AI_CIRCUIT_COOLDOWN_MS", 60_000),
        };
    })(),

    frontendUrl: requireUrl("FRONTEND_URL", "http://localhost:3000"),
    port: Number(process.env.PORT || 5000),

    /**
     * Payment provider credentials.
     *
     * When these are absent the platform falls back to an in-process simulator,
     * which is what keeps `docker compose up` and a fresh clone working without
     * anyone having to sign up for a merchant account. The simulator is refused
     * in production unless `ALLOW_PAYMENT_SIMULATOR` is explicitly set, so a
     * deployment can never quietly take money through a fake gateway or hand
     * out free entitlements by accident.
     *
     * The provider name is validated against a known set rather than cast. It
     * used to be `provider as "midtrans" | "simulator"`, and `getPaymentProvider`
     * resolves anything that is not `midtrans` to the simulator — so a typo'd
     * value like `PAYMENT_PROVIDER=midtranss` booted cleanly in production and
     * silently served every checkout through the fake gateway.
     */
    payments: (() => {
        const provider = (process.env.PAYMENT_PROVIDER || "").trim().toLowerCase();
        const serverKey = (process.env.PAYMENT_SERVER_KEY || "").trim();
        const clientKey = (process.env.PAYMENT_CLIENT_KEY || "").trim();
        const baseUrl = (process.env.PAYMENT_BASE_URL || "").trim();
        const allowSimulator = (process.env.ALLOW_PAYMENT_SIMULATOR || "").trim() === "true";

        const KNOWN_PROVIDERS = ["midtrans", "simulator"] as const;
        if (provider && !KNOWN_PROVIDERS.includes(provider as (typeof KNOWN_PROVIDERS)[number])) {
            throw new Error(
                `[config] PAYMENT_PROVIDER=${provider} is not a known provider ` +
                    `(expected one of: ${KNOWN_PROVIDERS.join(", ")}).`
            );
        }

        if (!provider || !serverKey) {
            if (isProd && !allowSimulator) {
                throw new Error(
                    "[config] PAYMENT_PROVIDER and PAYMENT_SERVER_KEY are required in production. " +
                        "Refusing to start with the payment simulator enabled. " +
                        "Set real credentials, or set ALLOW_PAYMENT_SIMULATOR=true " +
                        "if this is a local/demo deployment that must not take real payments."
                );
            }
            return { mode: "simulator" as const, serverKey: "", clientKey: "", baseUrl: "" };
        }

        if (isProd && provider === "simulator" && !allowSimulator) {
            throw new Error(
                "[config] PAYMENT_PROVIDER=simulator is not permitted in production " +
                    "(set ALLOW_PAYMENT_SIMULATOR=true to override for a local demo)."
            );
        }

        return {
            mode: provider as "midtrans" | "simulator",
            serverKey,
            clientKey,
            baseUrl: baseUrl || (provider === "midtrans" ? "https://app.midtrans.com" : ""),
        };
    })(),

    /**
     * Which video transport is in force.
     *
     * `jitsi` is retained only as a degraded path and is the default so that a
     * deployment which has not configured LiveKit still works. That is a real
     * downgrade - the jitsi path has no authentication - so the API reports it
     * on every join via `degraded`, and the client says so on screen. Making
     * livekit the default would instead fail closed with no video at all, which
     * is worse for a consultation that is minutes from starting.
     *
     * An *absent* value defaults to jitsi on purpose. An unrecognised value is
     * an error, and the distinction matters: this used to be a bare `as` cast,
     * so `VIDEO_PROVIDER=livekiit` booted cleanly, fell through
     * `activeProvider()` to the plain jitsi branch, and returned
     * `degraded: false`. The deployment served therapy sessions through a public
     * third-party room with no credential while reporting to the client - and
     * to the on-screen banner the client renders from it - that the session was
     * fine. The payments provider already learned this lesson
     * (`payment-config.test.ts` names the identical bug), and the video case is
     * worse: payments at least reports which mode it is in.
     */
    videoProvider: (() => {
        const provider = (process.env.VIDEO_PROVIDER || "").trim().toLowerCase();
        const KNOWN_VIDEO_PROVIDERS = ["livekit", "jitsi"] as const;
        if (provider && !KNOWN_VIDEO_PROVIDERS.includes(provider as (typeof KNOWN_VIDEO_PROVIDERS)[number])) {
            throw new Error(
                `[config] VIDEO_PROVIDER=${provider} is not a known provider ` +
                    `(expected one of: ${KNOWN_VIDEO_PROVIDERS.join(", ")}).`
            );
        }
        return (provider || "jitsi") as "livekit" | "jitsi";
    })(),

    livekit: {
        url: (process.env.LIVEKIT_URL || "").trim(),
        apiKey: (process.env.LIVEKIT_API_KEY || "").trim(),
        apiSecret: (process.env.LIVEKIT_API_SECRET || "").trim(),
    },

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
