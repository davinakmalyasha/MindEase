import { z } from "zod";
import { uuid7 } from "./params.schema";

export const UpdateUserRoleSchema = z.object({
    body: z.object({
        role: z.enum(["patient", "doctor", "admin"], "Invalid role"),
    }),
    params: z.object({
        id: uuid7,
    }),
});

export const UpdateVerificationSchema = z.object({
    body: z.object({
        status: z.enum(["approved", "rejected"], "Invalid verification status"),
    }),
    params: z.object({
        id: uuid7,
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
        id: uuid7,
    }),
});
