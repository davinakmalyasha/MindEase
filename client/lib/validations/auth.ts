import * as z from "zod";

export const passwordRules = z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain uppercase")
    .regex(/[0-9]/, "Must contain number")
    .regex(/[^A-Za-z0-9]/, "Must contain special char");

// E.164: + followed by 8-15 digits starting with a nonzero digit.
// Optional — WhatsApp features degrade gracefully without it.
export const phoneNumberRules = z
    .union([
        z.literal(""),
        z.string().regex(/^\+[1-9]\d{7,14}$/, "Use international format, e.g. +6281234567890"),
    ])
    .optional()
    .transform((v) => (v === "" ? undefined : v));

// Single source of truth shared by /register and the login page's register tab
export const RegisterSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters"),
    email: z.string().email("Invalid email address"),
    password: passwordRules,
    phone_number: phoneNumberRules,
    role: z.enum(["patient", "doctor"]),
});

export const LoginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1, "Password is required"),
});

export type RegisterFormData = z.infer<typeof RegisterSchema>;
export type LoginFormData = z.infer<typeof LoginSchema>;
