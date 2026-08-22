import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { RequestHandler } from "express";

// Disables a limiter under NODE_ENV=test (integration tests share one IP).
export const skipInTest = (mw: RequestHandler): RequestHandler =>
    process.env.NODE_ENV === "test" ? (_req, _res, next) => next() : mw;

export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // Limit each IP to 20 requests per windowMs
    message: {
        status: "error",
        message: "Too many login attempts, please try again after 15 minutes",
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Guards paid AI calls (Gemini) against cost abuse — 15 generation requests
// per 10 minutes per IP.
export const aiLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 15,
    message: {
        status: "error",
        message: "Too many AI requests, please try again later",
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Per-account brute-force protection for credential checks. Keyed by email
// when present (falls back to IP) so a single account cannot be hammered,
// even from behind a shared NAT.
export const accountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => {
        const email = (req.body?.email as string)?.trim().toLowerCase() || "";
        return email || ipKeyGenerator(req.ip || "unknown", 32);
    },
    message: {
        status: "error",
        message: "Too many attempts for this account, please try again after 15 minutes",
    },
    standardHeaders: true,
    legacyHeaders: false,
});
