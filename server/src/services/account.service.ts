import { prisma } from "../lib/prisma";
import argon2 from "argon2";
import crypto from "crypto";
import { MailerService } from "./mailer.service";
import { AuditService } from "./audit.service";
import { AuthService } from "./auth.service";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
/** A six-digit code has 900k possible values; cap guessing per account. */
const MAX_OTP_ATTEMPTS = 5;

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
            data: {
                password: hashed,
                resetOtpHash: null,
                resetOtpExpiresAt: null,
                resetOtpAttempts: 0,
            },
        });

        // A password change must evict sessions an attacker may already hold;
        // otherwise a stolen refresh cookie survives for up to 7 days.
        await AuthService.revokeAllSessions(userId, "password_changed");

        await AuditService.log({
            action: "user.password_changed",
            actorId: userId,
        }).catch(() => {});

        return { success: true, sessionsRevoked: true };
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
                resetOtpAttempts: 0,
            },
        });

        const { subject, html } = MailerService.buildOtpEmail(otp, "reset");
        await MailerService.send(user.email, subject, html).catch(() => {});

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
        if (user.resetOtpAttempts >= MAX_OTP_ATTEMPTS) {
            // Burn the code so the attempts already spent cannot be extended.
            await prisma.user.update({
                where: { id: user.id },
                data: { resetOtpHash: null, resetOtpExpiresAt: null },
            });
            throw new Error("Too many attempts. Please request a new code.");
        }

        const valid = await argon2.verify(user.resetOtpHash, otp);
        if (!valid) {
            await prisma.user.update({
                where: { id: user.id },
                data: { resetOtpAttempts: { increment: 1 } },
            });
            throw new Error("Invalid reset code");
        }

        const hashed = await argon2.hash(newPassword);
        await prisma.user.update({
            where: { id: user.id },
            data: {
                password: hashed,
                resetOtpHash: null,
                resetOtpExpiresAt: null,
                resetOtpAttempts: 0,
                // Enabling or changing a credential also revokes sessions that
                // were established with the old one.
                failedAttempts: 0,
                lockedUntil: null,
            },
        });

        await AuthService.revokeAllSessions(user.id, "password_reset");

        await AuditService.log({
            action: "user.password_reset",
            actorId: user.id,
        }).catch(() => {});

        return { success: true };
    }

    static async requestEmailVerification(email: string) {
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || user.isVerified) return { success: true }; // don't leak state

        const otp = generateOtp();
        const otpHash = await argon2.hash(otp);

        // Uses a dedicated slot: requesting a verification code must not
        // invalidate an in-flight password reset.
        await prisma.user.update({
            where: { id: user.id },
            data: {
                verifyOtpHash: otpHash,
                verifyOtpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
                verifyOtpAttempts: 0,
            },
        });

        const { subject, html } = MailerService.buildOtpEmail(otp, "verify");
        await MailerService.send(user.email, subject, html).catch(() => {});

        return { success: true };
    }

    static async verifyEmail(email: string, otp: string) {
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || user.isVerified) throw new Error("Invalid or already verified");
        if (!user.verifyOtpHash || !user.verifyOtpExpiresAt) {
            throw new Error("Verification code expired. Please request a new one.");
        }
        if (user.verifyOtpExpiresAt < new Date()) {
            throw new Error("Verification code expired. Please request a new one.");
        }
        if (user.verifyOtpAttempts >= MAX_OTP_ATTEMPTS) {
            await prisma.user.update({
                where: { id: user.id },
                data: { verifyOtpHash: null, verifyOtpExpiresAt: null },
            });
            throw new Error("Too many attempts. Please request a new code.");
        }

        const valid = await argon2.verify(user.verifyOtpHash, otp);
        if (!valid) {
            await prisma.user.update({
                where: { id: user.id },
                data: { verifyOtpAttempts: { increment: 1 } },
            });
            throw new Error("Invalid verification code");
        }

        await prisma.user.update({
            where: { id: user.id },
            data: {
                isVerified: true,
                verifyOtpHash: null,
                verifyOtpExpiresAt: null,
                verifyOtpAttempts: 0,
            },
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

        const doctorId = user.doctorProfile?.id ?? -1;
        // Derives from a random source rather than the row id, so the export
        // never echoes the internal primary key.
        const anonymizedEmail = `deleted-${crypto.randomBytes(8).toString("hex")}@deleted.invalid`;

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

            // Clinical disclosures. Appointments are retained (anonymised) for
            // the doctor's record, but the patient's free-text pre-session
            // answers and the AI briefing derived from them must not survive
            // deletion — otherwise the assigned doctor keeps reading them.
            prisma.preSessionData.deleteMany({ where: { appointment: { userId } } }),
            prisma.followUp.deleteMany({ where: { appointment: { userId } } }),

            prisma.availabilityPattern.deleteMany({ where: { doctorId } }),
            prisma.consultationSlot.deleteMany({ where: { doctorId } }),
            prisma.appointment.updateMany({
                where: { OR: [{ userId }, { doctorId }] },
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
                    resetOtpAttempts: 0,
                    verifyOtpHash: null,
                    verifyOtpExpiresAt: null,
                    verifyOtpAttempts: 0,
                    totpSecret: null,
                    totpEnabled: false,
                    backupCodes: null,
                    lastTotpStep: null,
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
