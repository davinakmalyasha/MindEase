import { Request, Response } from "express";
import { AccountService } from "../services/account.service";

export class AccountController {
    static async changePassword(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { currentPassword, newPassword } = req.body;
            const result = await AccountService.changePassword(userId, currentPassword, newPassword);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to change password.";
            res.status(400).json({ status: "error", message });
        }
    }

    static async forgotPassword(req: Request, res: Response) {
        try {
            const { email } = req.body;
            await AccountService.requestPasswordReset(email);
            res.json({ status: "success", message: "If the email exists, a reset code has been sent." });
        } catch (error: unknown) {
            res.status(400).json({ status: "error", message: "Failed to send reset code." });
        }
    }

    static async resetPassword(req: Request, res: Response) {
        try {
            const { email, otp, newPassword } = req.body;
            const result = await AccountService.resetPassword(email, otp, newPassword);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to reset password.";
            res.status(400).json({ status: "error", message });
        }
    }

    static async deleteAccount(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            await AccountService.deleteAccount(userId);
            res.clearCookie("refreshToken");
            res.clearCookie("accessToken");
            res.json({ status: "success", message: "Account deleted." });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to delete account.";
            res.status(400).json({ status: "error", message });
        }
    }

    static async sendVerification(req: Request, res: Response) {
        try {
            const { email } = req.body;
            await AccountService.requestEmailVerification(email);
            res.json({ status: "success", message: "If the email exists, a verification code has been sent." });
        } catch (error: unknown) {
            res.status(400).json({ status: "error", message: "Failed to send verification code." });
        }
    }

    static async verifyEmail(req: Request, res: Response) {
        try {
            const { email, otp } = req.body;
            const result = await AccountService.verifyEmail(email, otp);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Verification failed.";
            res.status(400).json({ status: "error", message });
        }
    }
}
