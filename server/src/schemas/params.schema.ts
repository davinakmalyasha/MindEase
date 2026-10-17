import { z } from "zod";

/**
 * Shared route-parameter shapes.
 *
 * `idObject` / `idParam` were duplicated across `auth.schema.ts` and
 * `wellness.schema.ts`. Every schema in this project is wrapped as
 * `{ body?, query?, params? }` because `validate` writes each key back
 * separately, so a bare `{ id }` shape silently matched nothing and rejected
 * every request — a failure mode worth having exactly one definition of.
 */
/**
 * UUIDv7, the identifier the product exposes.
 *
 * Strictly version 7 rather than \`z.uuid()\`: the format is the point of the
 * PRD requirement, and accepting v4 or a bare hex string would let the next
 * generator drift without anyone noticing. A numeric id is rejected outright -
 * sequential ids no longer exist in any response, so accepting one here would
 * quietly reintroduce the enumeration surface this change removes.
 */
export const uuid7 = z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Invalid id"
);

export const idObject = z.object({
    id: uuid7,
});

/** Route-level schema for a path that is only an `:id`. */
export const idParam = z.object({ params: idObject });

/**
 * Route-level schema for a path that is only an `:appointmentId`.
 *
 * Exists because `idParam` validates a param literally named `id`, so applying
 * it to `/ai/pre-session/:appointmentId` rejects every valid request with a
 * 400 - a shape mismatch that reads exactly like a broken endpoint. Two routes
 * had this gap the other way and no schema at all, so a non-numeric
 * `appointmentId` reached `parseInt` and became a 500.
 */
export const appointmentIdParam = z.object({
    params: z.object({
        appointmentId: uuid7,
    }),
});

/**
 * A wall-clock time as `HH:mm`, zero-padded.
 *
 * Times are stored in VARCHAR columns. Every overlap check in this codebase
 * therefore has to convert to minutes before comparing, because MySQL compares
 * those columns lexicographically and `"10:00" <= "9:00"` is true. That bug had
 * already been found and fixed twice — in `createSlot` and in the booking path
 * — when a third instance turned up in the availability-pattern overlap check.
 *
 * Enforcing the format at the boundary removes the whole class: a value that
 * cannot be mis-parsed cannot be mis-compared, and the `@@unique` indexes on
 * slot times (which match exact strings) become reliable.
 */
export const hhmm = (label: string) =>
    z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${label} must be HH:mm in 24-hour time`);
