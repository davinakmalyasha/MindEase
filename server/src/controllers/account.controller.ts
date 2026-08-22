import { Request, Response } from "express";
import { AccountService } from "../services/account.service";
import { prisma } from "../lib/prisma";

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
            const message = error instanceof Error ? error.message : "Failed to export data.";
            res.status(500).json({ status: "error", message });
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
