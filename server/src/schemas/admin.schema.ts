import { z } from "zod";

export const UpdateUserRoleSchema = z.object({
    body: z.object({
        role: z.enum(["patient", "doctor", "admin"], "Invalid role"),
    }),
    params: z.object({
        id: z.string().regex(/^\d+$/, "Invalid user id"),
    }),
});

export const UpdateVerificationSchema = z.object({
    body: z.object({
        status: z.enum(["approved", "rejected"], "Invalid verification status"),
    }),
    params: z.object({
        id: z.string().regex(/^\d+$/, "Invalid doctor id"),
    }),
});

export const BroadcastSchema = z.object({
    body: z.object({
        title: z.string().min(1).max(255),
        message: z.string().min(1).max(2000),
    }),
});

export const ReviewReportStatusSchema = z.object({
    body: z.object({
        status: z.enum(["resolved", "dismissed"], "Invalid status"),
    }),
    params: z.object({
        id: z.string().regex(/^\d+$/, "Invalid report id"),
    }),
});
