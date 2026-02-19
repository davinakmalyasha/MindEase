import { z } from "zod";

export const RegisterSchema = z.object({
    body: z.object({
        email: z.string().email(),
        password: z
            .string()
            .min(8, "Password must be at least 8 characters")
            .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
            .regex(/[0-9]/, "Password must contain at least one number")
            .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character"),
        name: z.string().min(2, "Name must be at least 2 characters"),
        phone_number: z.string().optional(),
        role: z.string().optional().default("patient"),
    }),
});

export const LoginSchema = z.object({
    body: z.object({
        email: z.string().email(),
        password: z.string().min(1, "Password is required"),
    }),
});

export const GoogleAuthSchema = z.object({
    body: z.object({
        token: z.string().min(1, "Google token is required"),
    }),
});
