import { Request, Response } from "express";
import { AuthService } from "../services/auth.service";

// Cookie Options
const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

export class AuthController {
    static async register(req: Request, res: Response) {
        try {
            const result = await AuthService.register(req.body);

            res.cookie("refreshToken", result.refreshToken, COOKIE_OPTIONS);
            res.cookie("accessToken", result.accessToken, { ...COOKIE_OPTIONS, maxAge: 15 * 60 * 1000 });

            res.status(201).json({ status: "success", data: { user: result.user, accessToken: result.accessToken } });
        } catch (error: any) {
            res.status(400).json({ status: "error", message: error.message });
        }
    }

    static async login(req: Request, res: Response) {
        try {
            const result = await AuthService.login(req.body);

            res.cookie("refreshToken", result.refreshToken, COOKIE_OPTIONS);
            res.cookie("accessToken", result.accessToken, { ...COOKIE_OPTIONS, maxAge: 15 * 60 * 1000 });

            res.json({ status: "success", data: { user: result.user, accessToken: result.accessToken } });
        } catch (error: any) {
            res.status(401).json({ status: "error", message: error.message });
        }
    }

    static async googleLogin(req: Request, res: Response) {
        try {
            const result = await AuthService.googleLogin(req.body.token);

            res.cookie("refreshToken", result.refreshToken, COOKIE_OPTIONS);
            res.cookie("accessToken", result.accessToken, { ...COOKIE_OPTIONS, maxAge: 15 * 60 * 1000 });

            res.json({ status: "success", data: { user: result.user, accessToken: result.accessToken } });
        } catch (error: any) {
            res.status(400).json({ status: "error", message: error.message });
        }
    }

    static async refresh(req: Request, res: Response) {
        try {
            const refreshToken = req.cookies.refreshToken;
            if (!refreshToken) return res.status(401).json({ message: "No refresh token" });

            const tokens = await AuthService.refresh(refreshToken);

            res.cookie("refreshToken", tokens.refreshToken, COOKIE_OPTIONS);
            res.cookie("accessToken", tokens.accessToken, { ...COOKIE_OPTIONS, maxAge: 15 * 60 * 1000 });

            res.json({ status: "success", accessToken: tokens.accessToken });
        } catch (error: any) {
            res.status(403).json({ status: "error", message: "Invalid refresh token" });
        }
    }

    static async logout(req: Request, res: Response) {
        const refreshToken = req.cookies.refreshToken;
        if (refreshToken) await AuthService.logout(refreshToken);

        res.clearCookie("refreshToken");
        res.clearCookie("accessToken");
        res.json({ status: "success", message: "Logged out" });
    }
}
