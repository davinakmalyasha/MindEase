import { PrismaClient, User } from "@prisma/client";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";

const prisma = new PrismaClient();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const JWT_SECRET = process.env.JWT_SECRET || "supersecret";
const REFRESH_SECRET = process.env.REFRESH_SECRET || "superrefreshsecret";
const REFRESH_TOKEN_DAYS = 7;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// Token Generators (include role claim for middleware use)
const generateTokens = (user: { id: number; role: string; totpEnabled?: boolean; totpVerified?: boolean }) => {
    const accessToken = jwt.sign(
        { userId: user.id, role: user.role, totpVerified: user.totpVerified ?? !user.totpEnabled },
        JWT_SECRET,
        { expiresIn: "15m" }
    );
    const refreshToken = jwt.sign(
        { userId: user.id, jti: crypto.randomUUID() },
        REFRESH_SECRET,
        { expiresIn: `${REFRESH_TOKEN_DAYS}d` }
    );
    return { accessToken, refreshToken };
};

const toSafeUser = (user: User) => {
    const {
        password,
        resetOtpHash,
        resetOtpExpiresAt,
        totpSecret,
        failedAttempts,
        lockedUntil,
        ...safe
    } = user;
    return safe;
};

export class AuthService {
    // Register Logic: Hash password, create user
    static async register(data: any) {
        const userData = data.body || data;
        if (!["patient", "doctor"].includes(userData.role)) {
            throw new Error("Invalid role. Roles must be patient or doctor.");
        }

        const existingUser = await prisma.user.findUnique({ where: { email: userData.email } });
        if (existingUser) throw new Error("Email already registered");

        const hashedPassword = await argon2.hash(userData.password);

        const user = await prisma.user.create({
            data: {
                email: userData.email,
                password: hashedPassword,
                name: userData.name,
                role: userData.role || "patient",
                phone_number: userData.phone_number,
                provider: "local",
                isVerified: false,
            },
        });

        if (user.role === "doctor") {
            await prisma.doctor.create({
                data: {
                    userId: user.id,
                    specialty: "General Psychologist",
                    bio: "Experienced mental health professional. Complete your profile to get started.",
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
        if (!user || !user.password) throw new Error("Invalid credentials");
        if (user.isBanned) throw new Error("Account suspended. Contact support.");

        // Lockout check
        if (user.lockedUntil && user.lockedUntil > new Date()) {
            throw new Error("Account temporarily locked due to too many failed attempts. Try again later.");
        }

        const validPassword = await argon2.verify(user.password, loginData.password);
        if (!validPassword) {
            const attempts = user.failedAttempts + 1;
            await prisma.user.update({
                where: { id: user.id },
                data: {
                    failedAttempts: attempts,
                    lockedUntil: attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null,
                },
            });
            throw new Error("Invalid credentials");
        }

        // Reset counter on success
        if (user.failedAttempts > 0 || user.lockedUntil) {
            await prisma.user.update({
                where: { id: user.id },
                data: { failedAttempts: 0, lockedUntil: null },
            });
        }

        const tokens = generateTokens(user);
        await this.storeRefreshToken(user.id, tokens.refreshToken);

        return { user: toSafeUser(user), ...tokens };
    }

    // Google Auth Logic: Verify token, find/create user
    static async googleLogin(token: string) {
        if (!process.env.GOOGLE_CLIENT_ID) {
            throw new Error("Google sign-in is not configured on the server");
        }

        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload || !payload.email) throw new Error("Invalid Google Token");

        let user = await prisma.user.findUnique({ where: { email: payload.email } });

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
                },
            });
        } else if (!user.googleId) {
            user = await prisma.user.update({
                where: { id: user.id },
                data: { googleId: payload.sub, avatar: payload.picture || user.avatar },
            });
        }

        if (user.isBanned) throw new Error("Account suspended. Contact support.");

        const tokens = generateTokens(user);
        await this.storeRefreshToken(user.id, tokens.refreshToken);

        return { user: toSafeUser(user), ...tokens };
    }

    // Store Refresh Token in DB (Rotation), pruning expired + oldest tokens
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
                token,
                userId,
                expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
            },
        });
    }

    static async logout(refreshToken: string) {
        await prisma.refreshToken.delete({ where: { token: refreshToken } }).catch(() => null);
    }

    static async refresh(token: string) {
        try {
            const decoded = jwt.verify(token, REFRESH_SECRET) as { userId: number };
            const storedToken = await prisma.refreshToken.findUnique({ where: { token } });

            if (!storedToken) {
                throw new Error("Invalid Refresh Token");
            }
            if (storedToken.expiresAt < new Date()) {
                throw new Error("Refresh Token Expired");
            }

            // Rotate: Delete old, create new
            await prisma.refreshToken.delete({ where: { id: storedToken.id } });

            const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
            if (!user || user.isBanned) throw new Error("User not found");

            const newTokens = generateTokens(user);
            await this.storeRefreshToken(decoded.userId, newTokens.refreshToken);
            return newTokens;
        } catch (error: any) {
            throw new Error(error.message || "Invalid Refresh Token");
        }
    }
}
