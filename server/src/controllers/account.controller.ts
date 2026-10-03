import { Request, Response } from "express";
import argon2 from "argon2";
import { AccountService } from "../services/account.service";
import { TwoFactorService } from "../services/twoFactor.service";
import { prisma } from "../lib/prisma";
import { publicMessageFor } from "../utils/appError";

export class AccountController {
    static async changePassword(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { currentPassword, newPassword } = req.body;
            const result = await AccountService.changePassword(userId, currentPassword, newPassword);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to change password.", status: 400 };
            res.status(status).json({ status: "error", message });
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
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to reset password.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async deleteAccount(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { password, code } = req.body as { password: string; code?: string };

            // Re-authenticate. This is the single most destructive request in the
            // API: it destroys a patient's treatment history irreversibly, so a
            // live session alone must not be enough.
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { password: true, totpEnabled: true, totpSecret: true },
            });
            if (!user) return res.status(404).json({ status: "error", message: "Account not found" });

            if (!user.password) {
                return res.status(400).json({
                    status: "error",
                    message: "This account signs in with Google and has no password. Contact support to delete it.",
                });
            }
            if (!(await argon2.verify(user.password, password))) {
                return res.status(401).json({ status: "error", message: "Password is incorrect" });
            }
            // An account with 2FA must clear that too.
            if (user.totpEnabled && user.totpSecret) {
                if (!code || !TwoFactorService.verifyCode(user.totpSecret, code)) {
                    return res
                        .status(400)
                        .json({ status: "error", message: "A valid two-factor code is required" });
                }
            }

            await AccountService.deleteAccount(userId);
            res.clearCookie("refreshToken");
            res.clearCookie("accessToken");
            res.json({ status: "success", message: "Account deleted." });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to delete account.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async exportData(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: {
                    email: true,
                    name: true,
                    avatar: true,
                    role: true,
                    phone_number: true,
                    provider: true,
                    createdAt: true,
                },
            });

            const [appointments, moods, preSession, reviews, messages] = await Promise.all([
                prisma.appointment.findMany({
                    where: { userId },
                    select: { appointmentDate: true, startTime: true, endTime: true, consultationType: true, status: true, notes: true, meetingLink: true, createdAt: true },
                    orderBy: { createdAt: "desc" },
                }),
                prisma.moodEntry.findMany({
                    where: { userId },
                    select: { mood: true, notes: true, createdAt: true },
                    orderBy: { createdAt: "asc" },
                }),
                prisma.preSessionData.findMany({
                    where: { appointment: { userId } },
                    select: { questionsJson: true, answersJson: true, briefingText: true, updatedAt: true },
                }),
                prisma.review.findMany({
                    where: { userId },
                    select: { rating: true, comment: true, doctorId: true, createdAt: true },
                }),
                prisma.message.findMany({
                    where: { senderId: userId },
                    select: { content: true, receiverId: true, createdAt: true },
                    orderBy: { createdAt: "asc" },
                }),
            ]);

            const exportData = {
                generatedAt: new Date().toISOString(),
                user,
                appointments,
                moods,
                preSession,
                reviews,
                messagesSent: messages,
            };

            res.setHeader("Content-Type", "application/json");
            res.setHeader("Content-Disposition", `attachment; filename="mindease-data-${userId}.json"`);
            res.json(exportData);
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to export data.", status: 500 };
            res.status(status).json({ status: "error", message });
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
            const { message, status } = publicMessageFor(error) ?? { message: "Verification failed.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }
}
