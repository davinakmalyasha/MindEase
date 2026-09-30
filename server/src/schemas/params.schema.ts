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
export const idObject = z.object({
    id: z.coerce.number().int().positive("Invalid id").max(2_147_483_647, "Invalid id"),
});

/** Route-level schema for a path that is only an `:id`. */
export const idParam = z.object({ params: idObject });

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
