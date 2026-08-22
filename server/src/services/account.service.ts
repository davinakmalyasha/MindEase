import { prisma } from "../lib/prisma";
import argon2 from "argon2";
import crypto from "crypto";
import { MailerService } from "./mailer.service";
import { AuditService } from "./audit.service";


const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

const generateOtp = () => crypto.randomInt(100000, 999999).toString();

export class AccountService {
    static async changePassword(userId: number, currentPassword: string, newPassword: string) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error("User not found");

        if (user.provider === "google" && !user.password) {
            throw new Error("This account uses Google sign-in and has no local password.");
        }

        const valid = await argon2.verify(user.password || "", currentPassword);
        if (!valid) throw new Error("Current password is incorrect");

        const hashed = await argon2.hash(newPassword);
        await prisma.user.update({
            where: { id: userId },
            data: { password: hashed, resetOtpHash: null, resetOtpExpiresAt: null },
        });
        return { success: true };
    }

    static async requestPasswordReset(email: string) {
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return { success: true }; // Don't reveal whether email exists

        if (user.provider === "google" && !user.password) {
            return { success: true };
        }

        const otp = generateOtp();
        const otpHash = await argon2.hash(otp);

        await prisma.user.update({
            where: { id: user.id },
            data: {
                resetOtpHash: otpHash,
                resetOtpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
            },
        });

        const { subject, html } = MailerService.buildOtpEmail(otp, "reset");
        await MailerService.send(user.email, subject, html);

        return { success: true };
    }

    static async resetPassword(email: string, otp: string, newPassword: string) {
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.resetOtpHash || !user.resetOtpExpiresAt) {
            throw new Error("Invalid or expired reset code");
        }
        if (user.resetOtpExpiresAt < new Date()) {
            throw new Error("Reset code expired. Please request a new one.");
        }

        const valid = await argon2.verify(user.resetOtpHash, otp);
        if (!valid) throw new Error("Invalid reset code");

        const hashed = await argon2.hash(newPassword);
        await prisma.user.update({
            where: { id: user.id },
            data: {
                password: hashed,
                resetOtpHash: null,
                resetOtpExpiresAt: null,
            },
        });
        return { success: true };
    }

    static async requestEmailVerification(email: string) {
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || user.isVerified) return { success: true }; // don't leak state

        const otp = generateOtp();
        const otpHash = await argon2.hash(otp);

        await prisma.user.update({
            where: { id: user.id },
            data: {
                resetOtpHash: otpHash,
                resetOtpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
            },
        });

        const { subject, html } = MailerService.buildOtpEmail(otp, "verify");
        await MailerService.send(user.email, subject, html);

        return { success: true };
    }

    static async verifyEmail(email: string, otp: string) {
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || user.isVerified) throw new Error("Invalid or already verified");
        if (!user.resetOtpHash || !user.resetOtpExpiresAt || user.resetOtpExpiresAt < new Date()) {
            throw new Error("Verification code expired. Please request a new one.");
        }

        const valid = await argon2.verify(user.resetOtpHash, otp);
        if (!valid) throw new Error("Invalid verification code");

        await prisma.user.update({
            where: { id: user.id },
            data: { isVerified: true, resetOtpHash: null, resetOtpExpiresAt: null },
        });
        return { success: true };
    }

    // GDPR-style account deletion: purge PII, keep anonymized records
    static async deleteAccount(userId: number) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { doctorProfile: true },
        });
        if (!user) throw new Error("User not found");

        const anonymizedEmail = `deleted-${userId}-${Date.now()}@mindease.app`;

        // Doctors whose public rating is influenced by this user's reviews
        const ratedDoctors = await prisma.review.findMany({
            where: { userId },
            select: { doctorId: true },
            distinct: ["doctorId"],
        });

        await prisma.$transaction([
            prisma.journalEntry.deleteMany({ where: { userId } }),
            prisma.assessment.deleteMany({ where: { userId } }),
            prisma.pushSubscription.deleteMany({ where: { userId } }),
            prisma.waitlistEntry.deleteMany({ where: { patientId: userId } }),
            prisma.referral.deleteMany({ where: { OR: [{ referrerId: userId }, { referredId: userId }] } }),
            prisma.packagePurchase.deleteMany({ where: { userId } }),
            prisma.review.deleteMany({ where: { userId } }),
            prisma.moodEntry.deleteMany({ where: { userId } }),
            prisma.message.deleteMany({
                where: { OR: [{ senderId: userId }, { receiverId: userId }] },
            }),
            prisma.notification.deleteMany({ where: { userId } }),
            prisma.refreshToken.deleteMany({ where: { userId } }),
            prisma.consultationSlot.deleteMany({
                where: { doctorId: user.doctorProfile?.id ?? -1 },
            }),
            prisma.appointment.updateMany({
                where: { OR: [{ userId }, { doctorId: user.doctorProfile?.id ?? -1 }] },
                data: {
                    notes: null,
                    status: "cancelled",
                },
            }),
            prisma.doctor.deleteMany({ where: { userId } }),
            prisma.user.update({
                where: { id: userId },
                data: {
                    email: anonymizedEmail,
                    name: "Deleted User",
                    password: null,
                    phone_number: null,
                    avatar: null,
                    googleId: null,
                    provider: "deleted",
                    isBanned: true,
                    resetOtpHash: null,
                    resetOtpExpiresAt: null,
                },
            }),
        ]);

        // Deleted reviews must stop influencing doctors' public averages
        const { ReviewService } = await import("./review.service");
        await Promise.all(ratedDoctors.map((r) => ReviewService.recalcDoctorRating(r.doctorId).catch(() => {})));

        await AuditService.log({
            action: "user.account_deleted",
            actorId: userId,
            targetType: "User",
            targetId: userId,
        });

        return { success: true };
    }
}
