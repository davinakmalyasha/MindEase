import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { AuthService } from "../services/auth.service";
import { TwoFactorService } from "../services/twoFactor.service";
import { env } from "../config/env";
import { publicMessageFor } from "../utils/appError";

const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax" as const,
    maxAge: 7 * 24 * 60 * 60 * 1000,
};

/** Recovery-code hashes must never leave the server. */
const sanitize = (user: any) => {
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

export class TwoFactorController {
    static async verifyLogin(req: Request, res: Response) {
        try {
            const { token, code } = req.body;
            const userId = TwoFactorService.verifyPendingToken(token);

            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (!user || !user.totpSecret || !user.totpEnabled) {
                throw new Error("Invalid or expired verification session");
            }
            if (user.isBanned) {
                throw new Error("Account suspended. Contact support.");
            }

            // Accept either a live, not-yet-used TOTP code or an unused
            // single-use backup code.
            const acceptedTotp = await TwoFactorService.consumeTotpStep(
                user.id,
                user.totpSecret,
                String(code)
            );
            if (!acceptedTotp) {
                const usedBackup = await TwoFactorService.consumeBackupCode(user.id, String(code));
                if (!usedBackup) throw new Error("Invalid verification code");
            }

            // `amr: ["otp"]` records that this session cleared a second factor,
            // so rotation can carry that assurance forward.
            const { accessToken, refreshToken } = AuthService.generateTokens(user, {
                amr: ["pwd", "otp"],
            });
            await AuthService.storeRefreshToken(user.id, refreshToken);

            res.cookie("refreshToken", refreshToken, COOKIE_OPTIONS);
            res.cookie("accessToken", accessToken, { ...COOKIE_OPTIONS, maxAge: 15 * 60 * 1000 });

            // The access token is delivered only as an HttpOnly cookie — never
            // in the response body, which would defeat the cookie's purpose.
            res.json({ status: "success", data: { user: sanitize(user) } });
        } catch (error: any) {
            res.status(401).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
        }
    }

    static async setup(req: Request, res: Response) {
        try {
            const user = req.user!;
            // The password is threaded through rather than dropped: enrolment is a
            // privilege change and every sibling one (disable, change password,
            // delete account) requires confirmation. See
            // `TwoFactorService.generateSecret`.
            const { password } = req.body;
            const result = await TwoFactorService.generateSecret(user, password);
            res.json({ status: "success", data: result });
        } catch (error: any) {
            res.status(400).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
        }
    }

    static async enable(req: Request, res: Response) {
        try {
            const user = req.user!;
            const { code } = req.body;
            const result = await TwoFactorService.enable(user.id, code);
            res.json({ status: "success", data: result });
        } catch (error: any) {
            res.status(400).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
        }
    }

    static async disable(req: Request, res: Response) {
        try {
            const user = req.user!;
            const { code, password } = req.body;
            const result = await TwoFactorService.disable(user.id, code, password);
            res.json({ status: "success", data: result });
        } catch (error: any) {
            res.status(400).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
        }
    }
}
