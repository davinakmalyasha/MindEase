import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { AuthService } from "../services/auth.service";
import { TwoFactorService } from "../services/twoFactor.service";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";
const REFRESH_SECRET = process.env.REFRESH_SECRET || "superrefreshsecret";

const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 7 * 24 * 60 * 60 * 1000,
};

const generateAccessFor = (user: any) =>
    jwt.sign({ userId: user.id, role: user.role, totpVerified: true }, JWT_SECRET, { expiresIn: "15m" });
const generateRefreshFor = (user: any) =>
    jwt.sign({ userId: user.id, jti: crypto.randomUUID() }, REFRESH_SECRET, { expiresIn: "7d" });

const sanitize = (user: any) => {
    const { password, resetOtpHash, resetOtpExpiresAt, totpSecret, failedAttempts, lockedUntil, ...safe } = user;
    return safe;
};

export class TwoFactorController {
    static async verifyLogin(req: Request, res: Response) {
        try {
            const { token, code } = req.body;
            const userId = TwoFactorService.verifyPendingToken(token);

            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (!user || !user.totpSecret) throw new Error("Invalid session");
            if (!TwoFactorService.verifyCode(user.totpSecret, code)) {
                throw new Error("Invalid verification code");
            }

            const accessToken = generateAccessFor(user);
            const refreshToken = generateRefreshFor(user);
            await AuthService.storeRefreshToken(user.id, refreshToken);

            res.cookie("refreshToken", refreshToken, COOKIE_OPTIONS);
            res.cookie("accessToken", accessToken, { ...COOKIE_OPTIONS, maxAge: 15 * 60 * 1000 });

            res.json({ status: "success", data: { user: sanitize(user), accessToken } });
        } catch (error: any) {
            res.status(401).json({ status: "error", message: error.message });
        }
    }

    static async setup(req: Request, res: Response) {
        try {
            const user = req.user!;
            const result = await TwoFactorService.generateSecret(user);
            res.json({ status: "success", data: result });
        } catch (error: any) {
            res.status(400).json({ status: "error", message: error.message });
        }
    }

    static async enable(req: Request, res: Response) {
        try {
            const user = req.user!;
            const { code } = req.body;
            const result = await TwoFactorService.enable(user.id, code);
            res.json({ status: "success", data: result });
        } catch (error: any) {
            res.status(400).json({ status: "error", message: error.message });
        }
    }

    static async disable(req: Request, res: Response) {
        try {
            const user = req.user!;
            const { code } = req.body;
            const result = await TwoFactorService.disable(user.id, code);
            res.json({ status: "success", data: result });
        } catch (error: any) {
            res.status(400).json({ status: "error", message: error.message });
        }
    }
}
