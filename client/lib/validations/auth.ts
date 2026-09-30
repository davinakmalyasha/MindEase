import * as z from "zod";

export const passwordRules = z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain uppercase")
    .regex(/[0-9]/, "Must contain number")
    .regex(/[^A-Za-z0-9]/, "Must contain special char");

// E.164: + followed by 8-15 digits starting with a nonzero digit.
// Optional — WhatsApp features degrade gracefully without it.
export const phoneNumberRules = z
    .union([
        z.literal(""),
        z.string().regex(/^\+[1-9]\d{7,14}$/, "Use international format, e.g. +6281234567890"),
    ])
    .optional()
    .transform((v) => (v === "" ? undefined : v));

// Single source of truth shared by /register and the login page's register tab
export const RegisterSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters"),
    email: z.string().email("Invalid email address"),
    password: passwordRules,
    phone_number: phoneNumberRules,
    role: z.enum(["patient", "doctor"]),
});

export const LoginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1, "Password is required"),
});

// The schema's *input* and *output* types differ: `phoneNumberRules` transforms
// `""` to `undefined`, so the key is optional on input but always present on
// output. React Hook Form holds the values the user typed (the input), while
// the submit handler receives the validated (output) values, so both types are
// needed and conflating them makes `zodResolver` unassignable to `useForm`.
// The output type is the one that reaches the API.
export type RegisterFormInput = z.input<typeof RegisterSchema>;
export type RegisterFormData = z.output<typeof RegisterSchema>;
export type LoginFormInput = z.input<typeof LoginSchema>;
export type LoginFormData = z.output<typeof LoginSchema>;

/**
 * Normalises validated form input into the exact payload the API accepts.
 *
 * React Hook Form's `handleSubmit` hands the handler the schema's *input* shape,
 * so the `phoneNumberRules` transform (which maps `""` to `undefined`) never
 * reaches the caller. Re-parsing applies it and guarantees the object on the
 * wire satisfies the schema, rather than sending `phone_number: ""` to an
 * endpoint that treats the field as optional.
 */
export const toRegisterPayload = (data: RegisterFormInput): RegisterFormData =>
    RegisterSchema.parse(data);
