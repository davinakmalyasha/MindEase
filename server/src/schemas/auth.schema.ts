import { z } from "zod";

export const RegisterSchema = z.object({
    body: z.object({
        email: z.string().email("Invalid email address"),
        password: z
            .string()
            .min(8, "Password must be at least 8 characters")
            .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
            .regex(/[0-9]/, "Password must contain at least one number")
            .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character"),
        name: z.string().min(2, "Name must be at least 2 characters"),
        phone_number: z.string().min(8, "Phone number must be at least 8 characters").optional(),
        role: z.enum(["patient", "doctor"]).optional().default("patient"),
    }),
});

export const LoginSchema = z.object({
    body: z.object({
        email: z.string().email("Invalid email address"),
        password: z.string().min(1, "Password is required"),
    }),
});

export const GoogleAuthSchema = z.object({
    body: z.object({
        token: z.string().min(1, "Google token is required"),
    }),
});

export const ChangePasswordSchema = z.object({
    body: z.object({
        currentPassword: z.string().min(1, "Current password is required"),
        newPassword: z
            .string()
            .min(8, "Password must be at least 8 characters")
            .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
            .regex(/[0-9]/, "Password must contain at least one number")
            .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character"),
    }),
});

export const ForgotPasswordSchema = z.object({
    body: z.object({
        email: z.string().email("Invalid email address"),
    }),
});

export const ResetPasswordSchema = z.object({
    body: z.object({
        email: z.string().email("Invalid email address"),
        otp: z.string().length(6, "OTP must be 6 digits").regex(/^\d{6}$/, "OTP must be 6 digits"),
        newPassword: z
            .string()
            .min(8, "Password must be at least 8 characters")
            .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
            .regex(/[0-9]/, "Password must contain at least one number")
            .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character"),
    }),
});

export const VerifyEmailSchema = z.object({
    body: z.object({
        email: z.string().email("Invalid email address"),
        otp: z.string().length(6, "OTP must be 6 digits").regex(/^\d{6}$/, "OTP must be 6 digits"),
    }),
});

export const ResendVerificationSchema = z.object({
    body: z.object({
        email: z.string().email("Invalid email address"),
    }),
});

export const TwoFactorVerifySchema = z.object({
    body: z.object({
        token: z.string().min(1, "Token is required"),
        code: z.string().min(6, "Code must be 6 digits"),
    }),
});

export const TwoFactorCodeSchema = z.object({
    body: z.object({
        code: z.string().min(6, "Code must be 6 digits"),
    }),
});

export const RescheduleSchema = z.object({
    body: z.object({
        appointmentDate: z.string().min(1, "Date is required"),
        startTime: z.string().min(1, "Start time is required"),
        endTime: z.string().min(1, "End time is required"),
        slotId: z.number().int().positive().optional(),
    }),
    params: z.object({
        id: z.string().min(1),
    }),
});
