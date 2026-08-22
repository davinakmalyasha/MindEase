import { z } from "zod";

export const BookAppointmentSchema = z.object({
    body: z.object({
        doctorId: z.number().int().positive("Doctor is required"),
        appointmentDate: z.string().min(1, "Date is required"),
        startTime: z.string().min(1, "Start time is required"),
        endTime: z.string().min(1, "End time is required"),
        consultationType: z.enum(["video", "voice", "chat"]).default("video"),
        slotId: z.number().int().positive().optional(),
        idempotencyKey: z.string().min(8).max(64).optional(),
        notes: z.string().max(1000, "Notes must be under 1000 characters").optional(),
        packagePurchaseId: z.number().int().positive().optional(),
    }),
});

export const UpdateStatusSchema = z.object({
    body: z.object({
        status: z.enum(["confirmed", "cancelled", "completed"]),
    }),
    params: z.object({
        id: z.string().min(1),
    }),
});

export const CreateSlotSchema = z.object({
    body: z.object({
        date: z.string().min(1, "Date is required"),
        start_time: z.string().min(1, "Start time is required"),
        end_time: z.string().min(1, "End time is required"),
    }),
});

export const CreatePatternSchema = z.object({
    body: z.object({
        weekday: z.number().int().min(0).max(6, "Weekday must be 0 (Monday) to 6 (Sunday)"),
        start_time: z.string().min(1, "Start time is required"),
        end_time: z.string().min(1, "End time is required"),
        activeFrom: z.string().optional(),
        weeks: z.number().int().min(1).max(12).optional(),
    }),
});

export const SuggestFollowUpSchema = z.object({
    body: z.object({
        suggestedDate: z.string().min(1, "Date is required"),
        startTime: z.string().min(1, "Start time is required"),
        endTime: z.string().min(1, "End time is required"),
        consultationType: z.enum(["video", "voice", "chat"]).optional(),
        notes: z.string().max(1000).optional(),
    }),
    params: z.object({
        id: z.string().regex(/^\d+$/, "Invalid appointment id"),
    }),
});
