import { z } from "zod";
import { uuid7 } from "./params.schema";
import { hhmm } from "./params.schema";

/** A calendar day, `YYYY-MM-DD`. Rejecting the shape here keeps `parseLocalDate` total. */
const isoDay = (label: string) =>
    z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be YYYY-MM-DD`)
        .refine((v) => !isNaN(Date.parse(`${v}T00:00:00Z`)), `${label} is not a real date`);

export const BookAppointmentSchema = z.object({
    body: z.object({
        doctorId: uuid7,
        appointmentDate: isoDay("Appointment date"),
        startTime: hhmm("Start time"),
        endTime: hhmm("End time"),
        consultationType: z.enum(["video", "voice", "chat"]).default("video"),
        /**
         * Optional, and that is a real gap rather than a convenience.
         *
         * Without a slot the only remaining gate is the same-day overlap scan,
         * so a caller can book a time no clinician ever published. That makes
         * the whole `ConsultationSlot` / `AvailabilityPattern` / waitlist model
         * advisory rather than enforced. Kept optional for now so existing
         * clients are not broken, but the service treats a slot-less booking as
         * a request rather than a confirmed appointment.
         */
        slotId: uuid7.optional(),
        idempotencyKey: z.string().min(8).max(64).optional(),
        notes: z.string().max(1000, "Notes must be under 1000 characters").optional(),
        packagePurchaseId: uuid7.optional(),
    }),
});

export const UpdateStatusSchema = z.object({
    body: z.object({
        status: z.enum(["confirmed", "cancelled", "completed"]),
    }),
    params: z.object({
        id: uuid7,
    }),
});

export const CreateSlotSchema = z.object({
    body: z.object({
        date: isoDay("Date"),
        start_time: hhmm("Start time"),
        end_time: hhmm("End time"),
    }),
});

export const CreatePatternSchema = z.object({
    body: z.object({
        weekday: z.number().int().min(0).max(6, "Weekday must be 0 (Monday) to 6 (Sunday)"),
        start_time: hhmm("Start time"),
        end_time: hhmm("End time"),
        activeFrom: isoDay("Active from").optional(),
        weeks: z.number().int().min(1).max(12).optional(),
    }),
});

export const SuggestFollowUpSchema = z.object({
    body: z.object({
        suggestedDate: isoDay("Suggested date"),
        startTime: hhmm("Start time"),
        endTime: hhmm("End time"),
        consultationType: z.enum(["video", "voice", "chat"]).optional(),
        notes: z.string().max(1000).optional(),
    }),
    params: z.object({
        id: uuid7,
    }),
});

export const RescheduleSchema = z.object({
    body: z.object({
        appointmentDate: isoDay("Appointment date"),
        startTime: hhmm("Start time"),
        endTime: hhmm("End time"),
        slotId: uuid7.optional(),
    }),
    params: z.object({
        id: uuid7,
    }),
});
