import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
    RegisterSchema,
    LoginSchema,
    ChangePasswordSchema,
    ForgotPasswordSchema,
    ResetPasswordSchema,
    RescheduleSchema,
} from "../schemas/auth.schema";
import { BookAppointmentSchema, UpdateStatusSchema, CreateSlotSchema } from "../schemas/appointment.schema";
import { CreateReviewSchema, LogMoodSchema } from "../schemas/wellness.schema";
import { SendMessageSchema } from "../schemas/message.schema";
import { GenerateQuestionsSchema, SubmitAnswersSchema, GenerateBriefingSchema } from "../schemas/ai.schema";

const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "accessToken",
});
registry.registerComponent("securitySchemes", "csrfToken", {
    type: "apiKey",
    in: "header",
    name: "X-CSRF-Token",
});

const registerBody = (path: string, method: "post" | "put" | "patch", schema: any, summary: string, security = true) => {
    registry.registerPath({
        method,
        path,
        summary,
        tags: [path.split("/")[2] || "api"],
        request: {
            body: { content: { "application/json": { schema } } },
        },
        responses: {
            200: { description: "Success" },
            201: { description: "Created" },
            400: { description: "Validation error" },
            401: { description: "Unauthorized" },
            403: { description: "Forbidden / CSRF failure" },
        },
        security: security ? [{ cookieAuth: [], csrfToken: [] }] : undefined,
    });
};

const registerGet = (path: string, summary: string, tag: string, security = true) => {
    registry.registerPath({
        method: "get",
        path,
        summary,
        tags: [tag],
        responses: { 200: { description: "Success" }, 401: { description: "Unauthorized" } },
        security: security ? [{ cookieAuth: [] }] : undefined,
    });
};

// Auth
registerBody("/api/auth/register", "post", RegisterSchema.shape.body, "Register a new user", false);
registerBody("/api/auth/login", "post", LoginSchema.shape.body, "Login with email/password", false);
registerBody("/api/auth/refresh", "post", z.object({}), "Rotate refresh token", false);
registerBody("/api/auth/logout", "post", z.object({}), "Logout", false);

// Account
registerBody("/api/account/forgot-password", "post", ForgotPasswordSchema.shape.body, "Request password reset OTP", false);
registerBody("/api/account/reset-password", "post", ResetPasswordSchema.shape.body, "Reset password with OTP", false);
registerBody("/api/account/change-password", "post", ChangePasswordSchema.shape.body, "Change password");
registerBody("/api/account/2fa/setup", "post", z.object({}), "Generate TOTP secret");
registerBody("/api/account/2fa/enable", "post", z.object({ code: z.string() }), "Enable 2FA");
registerBody("/api/account/2fa/disable", "post", z.object({ code: z.string() }), "Disable 2FA");

// Doctors
registerGet("/api/doctors", "List doctors", "doctors", false);
registerGet("/api/doctors/{id}", "Doctor detail", "doctors", false);
registerGet("/api/doctors/slots/{id}", "Doctor slots", "doctors", false);
registerBody("/api/doctors/slots", "post", CreateSlotSchema.shape.body, "Create availability slot");
registerBody("/api/doctors/slots/{id}", "post", z.object({}), "Delete slot"); // delete shown as post workaround
registry.registerPath({
    method: "delete",
    path: "/api/doctors/slots/{id}",
    summary: "Delete an open slot",
    tags: ["doctors"],
    responses: { 200: { description: "Success" }, 400: { description: "Slot booked or not found" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});

// Appointments
registerBody("/api/appointments/book", "post", BookAppointmentSchema.shape.body, "Book an appointment");
registerGet("/api/appointments/my", "My appointments (role-aware)", "appointments");
registerBody("/api/appointments/{id}/status", "put", UpdateStatusSchema.shape.body, "Update appointment status");
registerBody("/api/appointments/{id}/reschedule", "put", RescheduleSchema.shape.body, "Reschedule appointment");

// Reviews
registerBody("/api/reviews", "post", CreateReviewSchema.shape.body, "Create a review for a completed session");
registerGet("/api/reviews/doctor/{doctorId}", "Reviews for a doctor", "reviews", false);
registerGet("/api/reviews/doctor/{doctorId}/summary", "Rating summary", "reviews", false);

// Wellness
registerBody("/api/wellness/mood", "post", LogMoodSchema.shape.body, "Log a daily mood");
registerGet("/api/wellness/mood", "Mood history", "wellness");
registerGet("/api/wellness/mood/stats", "Mood stats & streaks", "wellness");

// Messages
registerGet("/api/messages/conversations", "Conversation list", "messages");
registerGet("/api/messages/{userId}/messages", "Message thread with a user", "messages");
registerBody("/api/messages/{userId}", "post", SendMessageSchema.shape.body, "Send a message");

// AI
registerBody("/api/ai/pre-session", "post", GenerateQuestionsSchema.shape.body, "Generate pre-session questions");
registerBody("/api/ai/pre-session/answers", "post", SubmitAnswersSchema.shape.body, "Submit pre-session answers");
registerGet("/api/ai/pre-session/{appointmentId}", "Get pre-session data", "ai");
registerBody("/api/ai/briefing", "post", GenerateBriefingSchema.shape.body, "Generate doctor briefing");
registerGet("/api/ai/briefing/{appointmentId}", "Get cached briefing", "ai");
registerBody("/api/ai/resources", "post", z.object({}), "Personalized wellness suggestions");

// Notifications & Admin
registerGet("/api/notifications", "Notification list", "notifications");
registerGet("/api/notifications/unread-count", "Unread count", "notifications");
registerGet("/api/admin/stats", "System stats", "admin");
registerGet("/api/admin/users", "Paginated user list", "admin");
registerGet("/api/admin/audit-logs", "Audit log trail", "admin");
registerBody("/api/admin/users/{id}/role", "patch", z.object({ role: z.enum(["patient", "doctor", "admin"]) }), "Change user role");
registerBody("/api/admin/users/{id}/ban", "patch", z.object({}), "Toggle user ban");

// Health
registerGet("/api/health", "Liveness check", "system", false);
registerGet("/api/health/db", "DB readiness check", "system", false);
registerGet("/api/csrf-token", "Obtain CSRF token", "system", false);

const generator = new OpenApiGeneratorV3(registry.definitions);
export const openApiDocument = generator.generateDocument({
    openapi: "3.0.0",
    info: {
        title: "MindEase API",
        version: "1.0.0",
        description:
            "MindEase mental health consultation platform API. All mutating requests require the CSRF token obtained from GET /api/csrf-token (sent as the X-CSRF-Token header).",
    },
    servers: [{ url: "http://localhost:5000" }],
});
