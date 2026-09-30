import { z } from "zod";
import { idObject } from "./params.schema";

/**
 * `POST /api/doctors/away`
 *
 * This route had no schema. `req.body.awayUntil` went unvalidated into
 * `parseLocalDate`, and because the controller coalesced a missing field to
 * `null`, a request with an empty body silently *cleared* a clinician's away
 * window — the opposite of the click that most likely produced it.
 *
 * The date is a `YYYY-MM-DD` calendar day, matching what the availability UI
 * sends, and is bounded to two years out so a mistyped far-future date cannot
 * hide a clinician's slots indefinitely.
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const awayDay = z
    .string()
    .regex(ISO_DAY, "Use the format YYYY-MM-DD")
    .refine((value) => !isNaN(Date.parse(`${value}T00:00:00Z`)), "Not a real calendar date");

export const SetAwaySchema = z.object({
    body: z
        .object({
            /**
             * Required, and explicitly nullable.
             *
             * Making the key required means `{}` is a 400 rather than a silent
             * "clear away mode". The client must say which it means.
             */
            awayUntil: awayDay.nullable(),
        })
        .strict(),
});

export const DoctorIdSchema = z.object({ params: idObject });
