import { z } from "zod";

export const UpdateUserRoleSchema = z.object({
    body: z.object({
        role: z.enum(["patient", "doctor", "admin"], "Invalid role"),
    }),
    params: z.object({
        id: z.string().regex(/^\d+$/, "Invalid user id"),
    }),
});
