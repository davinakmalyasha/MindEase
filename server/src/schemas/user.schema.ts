import { z } from "zod";

/**
 * `PUT /api/users/profile` previously had no schema at all: the controller
 * spread `req.body` straight into the service. The service's own allowlist
 * kept privileged fields (`role`, `isBanned`, `sessionCredits`) out of reach,
 * but nothing bounded the free-text fields or the price, so a client could
 * store a negative price — which then flowed into admin revenue totals — or an
 * arbitrarily long bio straight into an AI prompt.
 */
const MAX_BIO = 4000;
const MAX_NAME = 120;
const MAX_PHONE = 20;

const optionalTrimmed = (max: number) =>
    z
        .string()
        .trim()
        .min(1, "Cannot be empty")
        .max(max, `Must be ${max} characters or fewer`)
        .optional();

/**
 * Accepts a real boolean or the strings `"true"` / `"false"`.
 *
 * The profile form submits as `multipart/form-data`, and every value in a
 * multipart body arrives as a string — so a strict boolean field rejected the
 * opt-in toggle outright. `z.coerce.boolean()` is not enough on its own because
 * it treats any non-empty string as `true`, which would make `"false"` truthy.
 */
const booleanish = z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .transform((v) => v === true || v === "true" || v === "1");

export const UpdateProfileSchema = z.object({
    body: z
        .object({
            name: optionalTrimmed(MAX_NAME),
            phone_number: optionalTrimmed(MAX_PHONE),
            bio: optionalTrimmed(MAX_BIO),
            specialty: optionalTrimmed(120),
            experience: z.coerce.number().int().min(0).max(60).optional(),
            // Indonesian Rupiah, whole units. Zero means "not set"; negative was
            // previously accepted and corrupted revenue reporting.
            price: z.coerce.number().int().min(0).max(50_000_000).optional(),
            languages: optionalTrimmed(200),
            education: optionalTrimmed(2000),
            licenseNumber: optionalTrimmed(120),
            licenseIssuer: optionalTrimmed(160),
            bankName: optionalTrimmed(120),
            bankAccount: optionalTrimmed(64),
            bankHolder: optionalTrimmed(120),
            availability: optionalTrimmed(120),
            weeklyReportEnabled: booleanish.optional(),
            /** Legacy snake_case key still sent by the profile form. */
            weekly_report_enabled: booleanish.optional(),
            timezone: z.string().trim().min(1).max(64).optional(),
            /**
             * An avatar may only be set by the multipart upload. Accepting it
             * from the body let a caller point their profile at an arbitrary
             * URL — a tracking pixel, or an SVG served from an origin that
             * executes script in the image context.
             */
        })
        .strict()
        // Collapse the legacy key onto the canonical one so the service reads a
        // single shape regardless of which the client used.
        .transform(({ weekly_report_enabled, ...rest }) =>
            weekly_report_enabled === undefined
                ? rest
                : {
                      ...rest,
                      weeklyReportEnabled:
                          rest.weeklyReportEnabled ?? weekly_report_enabled,
                  }
        ),
});
