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
