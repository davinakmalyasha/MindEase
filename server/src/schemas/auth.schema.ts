import { z } from "zod";

/**
 * Shared primitives.
 *
 * `.strict()` makes an unexpected key an error rather than a silently dropped
 * one, so a caller cannot smuggle extra fields into a handler that spreads
 * `req.body`. Bounds are explicit on every free-text field: without them a 1 MB
 * body cap is the only limit on what reaches the database and, for fields that
 * flow into AI prompts, the only limit on what reaches a third party.
 */
const trimmed = (max: number, message?: string) =>
    z.string().trim().min(1, message || "Required").max(max, `Must be ${max} characters or fewer`);

export const passwordRules = z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200, "Password must be at most 200 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[0-9]/, "Password must contain at least one number")
    .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character");

import { idObject, idParam } from "./params.schema";

// Re-exported so existing imports keep working; the definitions now live in one
// place rather than being duplicated per schema file.
export { idObject, idParam };

export const RegisterSchema = z.object({
    body: z
        .object({
            email: z.string().trim().email("Invalid email address").max(254),
            password: passwordRules,
            name: trimmed(120, "Name must be at least 1 character"),
            phone_number: z
                .string()
                .trim()
                .min(8, "Phone number must be at least 8 characters")
                .max(20, "Phone number must be at most 20 characters")
                .optional(),
            role: z.enum(["patient", "doctor"]).optional().default("patient"),
            referralCode: z.string().trim().min(4).max(20).optional(),
        })
        .strict(),
});

export const LoginSchema = z.object({
    body: z
        .object({
            email: z.string().trim().email("Invalid email address").max(254),
            password: z.string().min(1, "Password is required").max(200),
        })
        .strict(),
});

export const GoogleAuthSchema = z.object({
    body: z
        .object({
            token: z.string().min(1, "Google token is required").max(4096),
        })
        .strict(),
});

export const ChangePasswordSchema = z.object({
    body: z
        .object({
            currentPassword: z.string().min(1, "Current password is required").max(200),
            newPassword: passwordRules,
        })
        .strict(),
});

export const ForgotPasswordSchema = z.object({
    body: z
        .object({
            email: z.string().trim().email("Invalid email address").max(254),
        })
        .strict(),
});

export const ResetPasswordSchema = z.object({
    body: z
        .object({
            email: z.string().trim().email("Invalid email address").max(254),
            otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
            newPassword: passwordRules,
        })
        .strict(),
});

export const VerifyEmailSchema = z.object({
    body: z
        .object({
            email: z.string().trim().email("Invalid email address").max(254),
            otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
        })
        .strict(),
});

export const ResendVerificationSchema = z.object({
    body: z
        .object({
            email: z.string().trim().email("Invalid email address").max(254),
        })
        .strict(),
});

export const TwoFactorVerifySchema = z.object({
    body: z
        .object({
            token: z.string().min(1, "Token is required").max(4096),
            // A TOTP code is 6 digits; a backup code is 4-4-4 hex groups.
            code: z
                .string()
                .trim()
                .regex(/^(\d{6}|[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4})$/i, "Invalid verification code"),
        })
        .strict(),
});

export const TwoFactorCodeSchema = z.object({
    body: z
        .object({
            code: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits"),
        })
        .strict(),
});

/**
 * Starting two-factor enrolment is a privilege change, not a read.
 *
 * This route had no schema at all and the controller dropped the body, so a
 * stolen access token could enrol an attacker's own authenticator and then lock
 * the real user out of their treatment records. It now carries the same
 * confirmation `disable` does.
 *
 * The password is optional rather than required because a Google-only account
 * has none. Which accounts those are is decided by `provider` inside
 * `generateSecret`, not by whether the stored hash happens to be null - and it
 * fails closed, so an unrecognised provider is confirmed rather than exempt.
 */
export const TwoFactorSetupSchema = z.object({
    body: z
        .object({
            password: z.string().min(1, "Password confirmation is required").max(200).optional(),
        })
        .strict(),
});

/** Disabling 2FA is the most sensitive self-service action on the account. */
export const TwoFactorDisableSchema = z.object({
    body: z
        .object({
            code: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits"),
            password: z.string().min(1, "Password confirmation is required").max(200),
        })
        .strict(),
});

/** Deleting an account is irreversible; require the credential to be re-entered. */
export const DeleteAccountSchema = z.object({
    body: z
        .object({
            password: z.string().min(1, "Password confirmation is required").max(200),
            code: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits").optional(),
        })
        .strict(),
});

// `RescheduleSchema` now lives in `appointment.schema.ts` alongside the other
// appointment bodies, so the `HH:mm` and `YYYY-MM-DD` rules are defined once.

