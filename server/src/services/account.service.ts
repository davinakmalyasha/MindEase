import { prisma } from "../lib/prisma";
import argon2 from "argon2";
import crypto from "crypto";
import { MailerService } from "./mailer.service";
import { AuditService } from "./audit.service";
import { AuthService } from "./auth.service";
import { badRequest, conflict, notFound } from "../utils/appError";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
/** A six-digit code has 900k possible values; cap guessing per account. */
const MAX_OTP_ATTEMPTS = 5;

const generateOtp = () => crypto.randomInt(100000, 999999).toString();

export class AccountService {
    static async changePassword(userId: number, currentPassword: string, newPassword: string) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw notFound("User not found");

        if (user.provider === "google" && !user.password) {
            throw badRequest("This account uses Google sign-in and has no local password.");
        }

        const valid = await argon2.verify(user.password || "", currentPassword);
        if (!valid) throw badRequest("Current password is incorrect");

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
            throw badRequest("Invalid or expired reset code");
        }
        if (user.resetOtpExpiresAt < new Date()) {
            throw badRequest("Reset code expired. Please request a new one.");
        }
        if (user.resetOtpAttempts >= MAX_OTP_ATTEMPTS) {
            // Burn the code so the attempts already spent cannot be extended.
            await prisma.user.update({
                where: { id: user.id },
                data: { resetOtpHash: null, resetOtpExpiresAt: null },
            });
            throw badRequest("Too many attempts. Please request a new code.");
        }

        const valid = await argon2.verify(user.resetOtpHash, otp);
        if (!valid) {
            await prisma.user.update({
                where: { id: user.id },
                data: { resetOtpAttempts: { increment: 1 } },
            });
            throw badRequest("Invalid reset code");
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
        if (!user || user.isVerified) throw conflict("Invalid or already verified");
        if (!user.verifyOtpHash || !user.verifyOtpExpiresAt) {
            throw badRequest("Verification code expired. Please request a new one.");
        }
        if (user.verifyOtpExpiresAt < new Date()) {
            throw badRequest("Verification code expired. Please request a new one.");
        }
        if (user.verifyOtpAttempts >= MAX_OTP_ATTEMPTS) {
            await prisma.user.update({
                where: { id: user.id },
                data: { verifyOtpHash: null, verifyOtpExpiresAt: null },
            });
            throw badRequest("Too many attempts. Please request a new code.");
        }

        const valid = await argon2.verify(user.verifyOtpHash, otp);
        if (!valid) {
            await prisma.user.update({
                where: { id: user.id },
                data: { verifyOtpAttempts: { increment: 1 } },
            });
            throw badRequest("Invalid verification code");
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
        if (!user) throw notFound("User not found");

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

            /**
             * The safety plan and the care plan *are* deleted.
             *
             * Both were missed, and the consequence was worse than a retention
             * question: the `User` row is anonymised rather than removed, so their
             * content survived against `deleted-<hex>@deleted.invalid` - free text
             * a patient wrote about their own reasons to live, with no owner, no
             * clinician counterpart, no way to display it, and no way to export
             * it. Not exported, not deleted, not visible.
             *
             * That is also the wrong thing to keep on the merits, and the contrast
             * with the rows around them is the reason. Appointments are retained
             * because a clinician's record of sessions that happened is not the
             * patient's to erase. `RiskAlert` is retained because it is
             * system-generated and is a safety signal about a clinician's
             * patient. Neither argument applies to a document the patient
             * authored alone, with no clinical counterpart.
             *
             * `support.service.ts` tells a user that deleting their account purges
             * their journals, mood logs and screening results. The safety plan was
             * the exception nobody had written down.
             *
             * `carePlan` cascades to `CareGoal` and `CareStep` in the schema, so
             * one statement clears all three.
             */
            prisma.safetyPlan.deleteMany({ where: { userId } }),
            prisma.carePlan.deleteMany({ where: { userId } }),

            /**
             * `RiskAlert` rows are deliberately NOT deleted.
             *
             * A risk alert is the durable record that a patient disclosed
             * thoughts of self-harm and a clinician was paged. Its `reason` is
             * system-generated ("PHQ-9 item 9 ... answered 'several days'"), not
             * patient-authored prose, and the linked `User` is anonymised below,
             * so nothing identifying survives. Erasing the row instead would
             * quietly remove a safety signal from a clinician's queue for
             * someone who is no longer their patient.
             *
             * When the departing account is a *clinician*, only alerts the
             * clinician raised as an acknowledger are relevant, and those
             * already point at an anonymised actor id.
             */

            prisma.availabilityPattern.deleteMany({ where: { doctorId } }),
            prisma.consultationSlot.deleteMany({ where: { doctorId } }),
            prisma.appointment.updateMany({
                where: { OR: [{ userId }, { doctorId }] },
                data: {
                    notes: null,
                    status: "cancelled",
                },
            }),

            /**
             * The doctor profile is ANONYMISED, never deleted.
             *
             * Seven relations cascade from `Doctor` — appointments, reviews,
             * pre-session data, follow-ups, packages, waitlist entries and
             * consultation slots. A clinician deleting their own account
             * therefore used to erase every one of their patients' treatment
             * records: history nobody consented to, for patients who were never
             * notified, irreversibly. The comment directly above claims
             * appointments are retained, and the FK cascade is precisely what
             * prevented it.
             *
             * The `User` row is already anonymised by the update below, so the
             * clinician's identity, credentials and 2FA are gone regardless.
             * What remains here is a tombstone: a non-directory placeholder that
             * keeps every appointment row referentially intact. `bio` and the
             * bank details are cleared because they are authored/free-text
             * personal data; `verificationStatus` moves off `approved` so the
             * public directory filter never returns it.
             */
            prisma.doctor.updateMany({
                where: { userId },
                data: {
                    bio: "",
                    education: null,
                    languages: null,
                    bankName: null,
                    bankAccount: null,
                    bankHolder: null,
                    licenseNumber: null,
                    licenseIssuer: null,
                    availability: "Unavailable",
                    verificationStatus: "removed",
                    awayUntil: null,
                    // Public aggregates must not keep a departed clinician's
                    // ranking; there is no longer anyone to rank.
                    rating: 0,
                    totalReviews: 0,
                },
            }),
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
                    // Scheduling and preference state left behind. The weekly
                    // report and the care-check-in crons both scan on these
                    // columns, so a deleted account that still had
                    // `weeklyReportEnabled` would keep receiving a mental-health
                    // email to an address that no longer belongs to them.
                    weeklyReportEnabled: false,
                    notificationPrefs: null,
                    lastMoodNudgeAt: null,
                    lastDeclineNudgeAt: null,
                    sessionCredits: 0,
                    // A referral code is a live lookup key. Keeping it would let
                    // a later account claim credit earned by a departed one.
                    referralCode: null,
                    // Timezone is coarse location data. It is cleared alongside
                    // the rest; no retained row is read through the user's
                    // timezone, because the day keys were already materialised
                    // when those rows were written.
                    timezone: null,
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
