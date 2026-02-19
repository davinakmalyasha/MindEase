import { PrismaClient, User } from "@prisma/client";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { RegisterSchema, LoginSchema, GoogleAuthSchema } from "../schemas/auth.schema";
import { z } from "zod";

const prisma = new PrismaClient();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const JWT_SECRET = process.env.JWT_SECRET || "supersecret";
const REFRESH_SECRET = process.env.REFRESH_SECRET || "superrefreshsecret";

// Token Generators
const generateTokens = (userId: number) => {
    const accessToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: "15m" });
    const refreshToken = jwt.sign({ userId }, REFRESH_SECRET, { expiresIn: "7d" });
    return { accessToken, refreshToken };
};

export class AuthService {
    // Register Logic: Hash password, create user
    static async register(data: any) {
        const userData = data.body || data; // Handle both direct and wrapped
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
            },
        });

        if (user.role === "doctor") {
            await prisma.doctor.create({
                data: {
                    userId: user.id,
                    specialty: "General Psychologist",
                    bio: "Experienced professional",
                } as any
            });
        }

        const tokens = generateTokens(user.id);
        await this.storeRefreshToken(user.id, tokens.refreshToken);

        return { user, ...tokens };
    }

    // Login Logic: Verify password
    static async login(data: any) {
        const loginData = data.body || data;
        const user = await prisma.user.findUnique({ where: { email: loginData.email } });
        if (!user || !user.password) throw new Error("Invalid credentials");

        const validPassword = await argon2.verify(user.password, loginData.password);
        if (!validPassword) throw new Error("Invalid credentials");

        const tokens = generateTokens(user.id);
        await this.storeRefreshToken(user.id, tokens.refreshToken);

        return { user, ...tokens };
    }

    // Google Auth Logic: Verify token, find/create user
    static async googleLogin(token: string) {
        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload || !payload.email) throw new Error("Invalid Google Token");

        let user = await prisma.user.findUnique({ where: { email: payload.email } });

        if (!user) {
            // Create new user if not exists
            user = await prisma.user.create({
                data: {
                    email: payload.email,
                    name: payload.name,
                    avatar: payload.picture,
                    googleId: payload.sub,
                    provider: "google",
                },
            });
        } else if (!user.googleId) {
            // Link account if email exists but googleId is missing (Manual -> Google transition security check needed ideally, but merging here for simplicity as requested)
            user = await prisma.user.update({
                where: { id: user.id },
                data: { googleId: payload.sub, avatar: payload.picture || user.avatar }
            });
        }

        const tokens = generateTokens(user.id);
        await this.storeRefreshToken(user.id, tokens.refreshToken);

        return { user, ...tokens };
    }

    // Store Refresh Token in DB (Rotation)
    static async storeRefreshToken(userId: number, token: string) {
        // Ideally remove old tokens or limit count
        await prisma.refreshToken.create({
            data: {
                token,
                userId,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            }
        })
    }

    static async logout(refreshToken: string) {
        await prisma.refreshToken.delete({ where: { token: refreshToken } }).catch(() => null);
    }

    static async refresh(token: string) {
        try {
            const decoded = jwt.verify(token, REFRESH_SECRET) as { userId: number };
            const storedToken = await prisma.refreshToken.findUnique({ where: { token } });

            if (!storedToken) {
                console.error("[Refresh Error] Token not found in database:", token.substring(0, 20) + "...");
                throw new Error("Invalid Refresh Token");
            }

            // Rotate: Delete old, create new
            await prisma.refreshToken.delete({ where: { id: storedToken.id } });

            const newTokens = generateTokens(decoded.userId);
            await this.storeRefreshToken(decoded.userId, newTokens.refreshToken);
            return newTokens;
        } catch (error: any) {
            console.error("[Refresh Error] Detailed error:", error.message);
            throw error;
        }
    }
}
