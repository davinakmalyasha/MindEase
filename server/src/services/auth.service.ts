import { User } from "@prisma/client";
import argon2 from "argon2";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { AuditService } from "./audit.service";
import { signAccessToken, signRefreshToken, verifyToken, hashToken, type AuthMethod } from "../lib/tokens";
import { badRequest, conflict, notFound, unauthorized } from "../utils/appError";

const googleClient = new OAuth2Client(env.googleClientId);

const REFRESH_TOKEN_DAYS = 7;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Verified against on the miss path so a request for a non-existent account
 * costs the same wall time as one for a real account, removing the timing
 * oracle that distinguishes "no such user" from "wrong password".
 */
const DUMMY_PASSWORD_HASH =
    "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000";

type TokenBearingUser = { id: number; role: string; totpEnabled?: boolean };

/**
 * Mints a token pair. `totpVerified` is only true when the session has actually
 * satisfied a second factor (or the account has none) — `authenticate` refuses
 * any access token claiming otherwise for a 2FA-enabled account.
 */
export const generateTokens = (
    user: TokenBearingUser,
    options: { amr?: AuthMethod[] } = {}
) => {
    const amr = options.amr ?? ["pwd"];
    const totpVerified = !user.totpEnabled || amr.includes("otp");
    return {
        accessToken: signAccessToken({ id: user.id, role: user.role, totpVerified }),
        refreshToken: signRefreshToken(user.id, amr),
    };
};

const toSafeUser = (user: User) => {
    const {
        password,
        resetOtpHash,
        resetOtpExpiresAt,
        verifyOtpHash,
        verifyOtpExpiresAt,
        totpSecret,
        backupCodes,
        failedAttempts,
        lockedUntil,
        lastTotpStep,
        ...safe
    } = user;
    return safe;
};

/** A single message for every authentication failure, to avoid enumeration. */
const GENERIC_AUTH_ERROR = "Invalid credentials";

export class AuthService {
    /** Mints a token pair. Exposed so the two-factor flow can issue one only
     * after the second factor has actually been satisfied. */
    static generateTokens(user: TokenBearingUser, options: { amr?: AuthMethod[] } = {}) {
        return generateTokens(user, options);
    }

    // Register Logic: Hash password, create user
    static async register(data: any) {
        const userData = data.body || data;
        if (!["patient", "doctor"].includes(userData.role)) {
            throw badRequest("Invalid role. Roles must be patient or doctor.");
        }

        const existingUser = await prisma.user.findUnique({ where: { email: userData.email } });
        if (existingUser) throw conflict("Email already registered");

        const hashedPassword = await argon2.hash(userData.password);

        const referralCode = `ME-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

        const user = await prisma.user.create({
            data: {
                email: userData.email,
                password: hashedPassword,
                name: userData.name,
                role: userData.role || "patient",
                phone_number: userData.phone_number,
                provider: "local",
                isVerified: false,
                referralCode,
            },
        });

        // Track referrals: a new user registered with a friend's code
        if (userData.referralCode) {
            const referrer = await prisma.user.findFirst({
                where: { referralCode: userData.referralCode.trim().toUpperCase(), id: { not: user.id } },
            });
            if (referrer) {
                await prisma.referral
                    .create({
                        data: {
                            referrerId: referrer.id,
                            referredId: user.id,
                            code: userData.referralCode.trim().toUpperCase(),
                        },
                    })
                    .catch(() => {});
            }
        }

        if (user.role === "doctor") {
            await prisma.doctor.create({
                data: {
                    userId: user.id,
                    specialty: "General Psychologist",
                    bio: "Experienced mental health professional. Complete your profile to get started.",
                    verificationStatus: "pending",
                },
            });
        }

        const tokens = generateTokens(user);
        await this.storeRefreshToken(user.id, tokens.refreshToken);

        return { user: toSafeUser(user), ...tokens };
    }

    // Login Logic: Verify password with lockout protection
    static async login(data: any) {
        const loginData = data.body || data;
        const user = await prisma.user.findUnique({ where: { email: loginData.email } });

        // Always spend the same verification cost, whether or not the account
        // exists, so response timing cannot be used to enumerate users.
        const validPassword = await argon2.verify(user?.password || DUMMY_PASSWORD_HASH, loginData.password);

        if (!user || !user.password) throw unauthorized(GENERIC_AUTH_ERROR);
        if (!validPassword) {
            if (!user.isBanned) await this.recordFailedAttempt(user);
            throw unauthorized(GENERIC_AUTH_ERROR);
        }

        // A suspended account is only revealed once the caller has proved they
        // own it, so this cannot be used to probe for banned accounts.
        if (user.isBanned) throw badRequest("Account suspended. Contact support.");

        // Lockout check happens after the password check so a locked account
        // is not distinguishable from a wrong password.
        if (user.lockedUntil && user.lockedUntil > new Date()) {
            throw badRequest("Account temporarily locked due to too many failed attempts. Try again later.");
        }

        if (user.failedAttempts > 0 || user.lockedUntil) {
            await prisma.user.update({
                where: { id: user.id },
                data: { failedAttempts: 0, lockedUntil: null },
            });
        }

        await AuditService.log({
            action: "auth.login",
            actorId: user.id,
            meta: { provider: "local" },
        }).catch(() => {});

        // Accounts with 2FA enabled do NOT receive a refresh token here — a
        // session is only persisted once the second factor succeeds, so there
        // is no way to obtain a usable session by skipping 2FA.
        if (user.totpEnabled) {
            return { user: toSafeUser(user), requiresTwoFactor: true as const };
        }

        const tokens = generateTokens(user);
        await this.storeRefreshToken(user.id, tokens.refreshToken);

        return { user: toSafeUser(user), requiresTwoFactor: false as const, ...tokens };
    }

    private static async recordFailedAttempt(user: { id: number }) {
        // `{ increment: 1 }` in SQL, not `user.failedAttempts + 1` in JavaScript.
        //
        // The read-modify-write version had two failure modes and they compound.
        // Five concurrent wrong passwords all read `failedAttempts: 0` and all
        // wrote 1, so the counter never reached the threshold and the lockout
        // never fired under parallel load - unlimited guesses in batches of five.
        //
        // And `lockedUntil` was written unconditionally once the threshold was
        // reached, so every further failed attempt pushed the expiry fifteen
        // minutes further out. An attacker who kept hammering never let the lock
        // expire, which permanently denies a named patient the ability to sign in
        // or reset their password. On a mental-health product that is a
        // denial-of-care tool aimed at a specific person.
        //
        // The stamp is now applied only when no lock is currently in force, so the
        // window is a fixed fifteen minutes from the fifth failure rather than
        // fifteen minutes from the last attempt.
        await prisma.user
            .update({
                where: { id: user.id },
                data: {
                    failedAttempts: { increment: 1 },
                    ...(await this.stampLockIfUnlocked(user.id)),
                },
            })
            .catch(() => {});
    }

    /** The lock deadline, only when the account is not already locked. */
    private static async stampLockIfUnlocked(userId: number) {
        const current = await prisma.user.findUnique({
            where: { id: userId },
            select: { failedAttempts: true, lockedUntil: true },
        });
        const alreadyLocked = current?.lockedUntil && current.lockedUntil > new Date();
        if (alreadyLocked) return {};
        if ((current?.failedAttempts ?? 0) + 1 < MAX_FAILED_ATTEMPTS) return { lockedUntil: null as Date | null };
        return { lockedUntil: new Date(Date.now() + LOCKOUT_MS) };
    }

    // Google Auth Logic: Verify token, find/create user
    static async googleLogin(token: string) {
        if (!env.googleClientId) {
            throw badRequest("Google sign-in is not configured on the server");
        }

        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: env.googleClientId,
        });
        const payload = ticket.getPayload();
        if (!payload || !payload.email) throw badRequest("Invalid Google Token");
        // Never trust unverified emails — linking an account by email without
        // verification enables pre-account takeover.
        if (!payload.email_verified) throw badRequest("Google account email is not verified");

        let user = await prisma.user.findUnique({ where: { email: payload.email } });

        if (user?.isBanned) throw badRequest("Account suspended. Contact support.");

        if (!user) {
            // Create new user if not exists (Google-verified emails are auto-verified)
            user = await prisma.user.create({
                data: {
                    email: payload.email,
                    name: payload.name || payload.email.split("@")[0],
                    avatar: payload.picture,
                    googleId: payload.sub,
                    provider: "google",
                    isVerified: true,
                    referralCode: `ME-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
                },
            });
        } else if (!user.googleId) {
            // Identity merge per PRD: safe because Google verified email ownership
            user = await prisma.user.update({
                where: { id: user.id },
                data: { googleId: payload.sub, avatar: payload.picture || user.avatar },
            });
        }

        await AuditService.log({
            action: "auth.login",
            actorId: user.id,
            meta: { provider: "google" },
        }).catch(() => {});

        // Same gate as password login: no session is persisted until the
        // second factor has been satisfied.
        if (user.totpEnabled) {
            return { user: toSafeUser(user), requiresTwoFactor: true as const };
        }

        const tokens = generateTokens(user, { amr: ["google"] });
        await this.storeRefreshToken(user.id, tokens.refreshToken);

        return { user: toSafeUser(user), requiresTwoFactor: false as const, ...tokens };
    }

    // Store Refresh Token in DB (Rotation), pruning expired + oldest tokens.
    // Only the SHA-256 digest is persisted, so a database read cannot be
    // replayed as a live session.
    static async storeRefreshToken(userId: number, token: string) {
        await prisma.refreshToken.deleteMany({
            where: { userId, expiresAt: { lt: new Date() } },
        });

        const active = await prisma.refreshToken.count({ where: { userId } });
        if (active >= 5) {
            const oldest = await prisma.refreshToken.findMany({
                where: { userId },
                orderBy: { createdAt: "asc" },
                take: active - 4,
                select: { id: true },
            });
            await prisma.refreshToken.deleteMany({
                where: { id: { in: oldest.map((t) => t.id) } },
            });
        }

        return await prisma.refreshToken.create({
            data: {
                tokenHash: hashToken(token),
                userId,
                expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
            },
        });
    }

    /**
     * Invalidates every active session for a user. Called on password change,
     * password reset and 2FA enable/disable so a stolen refresh cookie cannot
     * outlive the credential it was obtained with.
     */
    static async revokeAllSessions(userId: number, reason: string) {
        const deleted = await prisma.refreshToken.deleteMany({ where: { userId } });
        if (deleted.count > 0) {
            await AuditService.log({
                action: "auth.sessions_revoked",
                actorId: userId,
                meta: { reason, revoked: deleted.count },
            }).catch(() => {});
        }
        return deleted.count;
    }

    static async logout(refreshToken: string) {
        await prisma.refreshToken
            .delete({ where: { tokenHash: hashToken(refreshToken) } })
            .catch(() => null);
    }

    static async refresh(token: string) {
        let decoded: { userId: number; amr?: AuthMethod[] };
        try {
            decoded = verifyToken<{ userId: number; amr?: AuthMethod[] }>(token, "refresh");
        } catch {
            throw badRequest("Invalid Refresh Token");
        }

        const storedToken = await prisma.refreshToken.findUnique({
            where: { tokenHash: hashToken(token) },
        });

        if (!storedToken) {
            // A cryptographically valid but unknown token means it was already
            // rotated (replayed) or revoked. Treat it as theft: revoke every
            // active session for the account and leave an audit trail.
            const revoked = await prisma.refreshToken
                .deleteMany({ where: { userId: decoded.userId } })
                .catch(() => ({ count: 0 }));
            await AuditService.log({
                action: "auth.refresh_reuse_detected",
                actorId: decoded.userId,
                meta: { reason: "unknown_token", revoked: revoked.count },
            }).catch(() => {});
            throw badRequest("Invalid Refresh Token");
        }

        if (storedToken.expiresAt < new Date()) {
            await prisma.refreshToken.delete({ where: { id: storedToken.id } }).catch(() => null);
            throw badRequest("Refresh Token Expired");
        }

        // Rotate: delete old, create new
        await prisma.refreshToken.delete({ where: { id: storedToken.id } });

        const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
        if (!user || user.isBanned) throw notFound("User not found");

        // A refresh never *newly* satisfies a second factor — it only carries
        // forward the assurance the original session already had. A token
        // minted before 2FA was enabled therefore cannot be upgraded into a
        // verified session by rotating.
        const amr: AuthMethod[] = decoded.amr ?? ["pwd"];
        if (user.totpEnabled && !amr.includes("otp")) {
            throw badRequest("Two-factor verification required");
        }

        const newTokens = generateTokens(user, { amr });
        await this.storeRefreshToken(decoded.userId, newTokens.refreshToken);
        return newTokens;
    }
}
