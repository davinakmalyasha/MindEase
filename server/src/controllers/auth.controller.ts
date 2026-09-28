import { Request, Response } from "express";
import { AuthService } from "../services/auth.service";
import { TwoFactorService } from "../services/twoFactor.service";
import { env } from "../config/env";
import { publicMessageFor } from "../utils/appError";

const REFRESH_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax" as const,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

const ACCESS_COOKIE_OPTIONS = {
    ...REFRESH_COOKIE_OPTIONS,
    maxAge: 15 * 60 * 1000,
};

const setSessionCookies = (res: Response, accessToken: string, refreshToken: string) => {
    res.cookie("refreshToken", refreshToken, REFRESH_COOKIE_OPTIONS);
    res.cookie("accessToken", accessToken, ACCESS_COOKIE_OPTIONS);
};

const clearSessionCookies = (res: Response) => {
    // Options must match the ones used to set the cookie or the browser keeps it.
    res.clearCookie("refreshToken", REFRESH_COOKIE_OPTIONS);
    res.clearCookie("accessToken", ACCESS_COOKIE_OPTIONS);
};

export class AuthController {
    static async register(req: Request, res: Response) {
        try {
            const result = await AuthService.register(req.body);

            setSessionCookies(res, result.accessToken, result.refreshToken);

            // The access token is delivered only as an HttpOnly cookie. Returning
            // it in the body as well would make it readable by any script.
            res.status(201).json({ status: "success", data: { user: result.user } });
        } catch (error: any) {
            res.status(400).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
        }
    }

    static async login(req: Request, res: Response) {
        try {
            const result = await AuthService.login(req.body);

            // 2FA gate: no session cookie is issued until the second factor
            // succeeds, and no refresh token is ever persisted for this attempt.
            if (result.requiresTwoFactor) {
                return res.json({
                    status: "success",
                    data: {
                        requires2FA: true,
                        twoFactorToken: TwoFactorService.issuePendingToken(result.user.id),
                        user: result.user,
                    },
                });
            }

            setSessionCookies(res, result.accessToken!, result.refreshToken!);

            res.json({ status: "success", data: { user: result.user } });
        } catch (error: any) {
            res.status(401).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
        }
    }

    static async googleLogin(req: Request, res: Response) {
        try {
            const result = await AuthService.googleLogin(req.body.token);

            // 2FA gate: users with TOTP enabled must complete a second factor
            if (result.requiresTwoFactor) {
                return res.json({
                    status: "success",
                    data: {
                        requires2FA: true,
                        twoFactorToken: TwoFactorService.issuePendingToken(result.user.id),
                        user: result.user,
                    },
                });
            }

            setSessionCookies(res, result.accessToken!, result.refreshToken!);

            res.json({ status: "success", data: { user: result.user } });
        } catch (error: any) {
            res.status(400).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
        }
    }

    static async refresh(req: Request, res: Response) {
        try {
            const refreshToken = req.cookies.refreshToken;
            if (!refreshToken) return res.status(401).json({ message: "No refresh token" });

            const tokens = await AuthService.refresh(refreshToken);

            setSessionCookies(res, tokens.accessToken, tokens.refreshToken);

            res.json({ status: "success" });
        } catch (error: any) {
            clearSessionCookies(res);
            res.status(403).json({ status: "error", message: "Invalid refresh token" });
        }
    }

    static async logout(req: Request, res: Response) {
        const refreshToken = req.cookies.refreshToken;
        if (refreshToken) await AuthService.logout(refreshToken);

        clearSessionCookies(res);
        res.json({ status: "success", message: "Logged out" });
    }
}
