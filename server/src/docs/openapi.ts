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
import { BookAppointmentSchema, UpdateStatusSchema, CreateSlotSchema, CreatePatternSchema, SuggestFollowUpSchema } from "../schemas/appointment.schema";
import { CreateReviewSchema, LogMoodSchema, JournalEntrySchema, SubmitAssessmentSchema, ReplyReviewSchema, ReportReviewSchema } from "../schemas/wellness.schema";
import { SendMessageSchema, TypingSchema } from "../schemas/message.schema";
import { GenerateQuestionsSchema, SubmitAnswersSchema, GenerateBriefingSchema, MatchDoctorsSchema } from "../schemas/ai.schema";

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
registerBody("/api/auth/google", "post", z.object({ idToken: z.string() }), "Login / identity-merge via Google ID token", false);
registerBody("/api/auth/refresh", "post", z.object({}), "Rotate refresh token", false);
registerBody("/api/auth/logout", "post", z.object({}), "Logout", false);

// Account
registerBody("/api/account/forgot-password", "post", ForgotPasswordSchema.shape.body, "Request password reset OTP", false);
registerBody("/api/account/reset-password", "post", ResetPasswordSchema.shape.body, "Reset password with OTP", false);
registerBody("/api/account/change-password", "post", ChangePasswordSchema.shape.body, "Change password");
registerBody("/api/account/verify-email", "post", z.object({ email: z.string().email(), otp: z.string() }), "Verify email with 6-digit OTP", false);
registerBody("/api/account/resend-verification", "post", z.object({ email: z.string().email() }), "Resend the verification email", false);
registerGet("/api/account/export", "GDPR data export (JSON download)", "account");
registry.registerPath({
    method: "delete",
    path: "/api/account/me",
    summary: "Delete the account: purge PII, anonymize history",
    tags: ["account"],
    responses: { 200: { description: "Success" }, 401: { description: "Unauthorized" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});
registerBody("/api/account/2fa/setup", "post", z.object({}), "Generate TOTP secret");
registerBody("/api/account/2fa/enable", "post", z.object({ code: z.string() }), "Enable 2FA (returns single-use backup codes)");
registerBody("/api/account/2fa/disable", "post", z.object({ code: z.string(), password: z.string() }), "Disable 2FA (code + password)");

// Doctors
registerGet("/api/doctors", "List doctors", "doctors", false);
registerGet("/api/doctors/{id}", "Doctor detail", "doctors", false);
registerGet("/api/doctors/slots/{id}", "Doctor slots", "doctors", false);
registerGet("/api/doctors/analytics", "Doctor practice analytics", "doctors");
registerBody("/api/doctors/slots", "post", CreateSlotSchema.shape.body, "Create availability slot");
registerBody("/api/doctors/patterns", "post", CreatePatternSchema.shape.body, "Create weekly availability pattern (auto-generates slots)");
registerGet("/api/doctors/patterns", "List availability patterns", "doctors");
registerBody("/api/doctors/patterns/{id}", "post", z.object({}), "Delete pattern"); // delete shown as post workaround
registry.registerPath({
    method: "delete",
    path: "/api/doctors/patterns/{id}",
    summary: "Delete an availability pattern",
    tags: ["doctors"],
    responses: { 200: { description: "Success" }, 400: { description: "Pattern not found" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});

// Appointments
registerBody("/api/appointments/book", "post", BookAppointmentSchema.shape.body, "Book an appointment (optionally with a package session)");
registerGet("/api/appointments/my", "My appointments (role-aware)", "appointments");
registerGet("/api/appointments/{id}/rebook-options", "Rebook alternatives after cancellation", "appointments");
registerGet("/api/appointments/{id}/ics", "Download .ics calendar file", "appointments");
registerBody("/api/appointments/{id}/join", "post", z.object({}), "Join a consultation room (video/voice)");
registerBody("/api/appointments/{id}/status", "put", UpdateStatusSchema.shape.body, "Update appointment status");
registerBody("/api/appointments/{id}/reschedule", "put", RescheduleSchema.shape.body, "Reschedule appointment");
registerBody("/api/appointments/{id}/follow-up", "post", SuggestFollowUpSchema.shape.body, "Doctor suggests a follow-up session");
registerGet("/api/appointments/{id}/follow-up", "Get follow-up suggestion", "appointments");
registerBody("/api/follow-ups/{id}/accept", "post", z.object({}), "Accept a follow-up (creates a new booking)");
registerBody("/api/follow-ups/{id}/decline", "post", z.object({}), "Decline a follow-up");

// Reviews
registerBody("/api/reviews", "post", CreateReviewSchema.shape.body, "Create a review for a completed session");
registerBody("/api/reviews/{id}/reply", "post", ReplyReviewSchema.shape.body, "Doctor replies to a review on their own profile");
registerBody("/api/reviews/{id}/report", "post", ReportReviewSchema.shape.body, "Doctor reports a review on their own profile");
registerGet("/api/reviews/doctor/{doctorId}", "Reviews for a doctor", "reviews", false);
registerGet("/api/reviews/doctor/{doctorId}/summary", "Rating summary", "reviews", false);

// Wellness
registerBody("/api/wellness/mood", "post", LogMoodSchema.shape.body, "Log today's mood (re-logging updates the same-day entry)");
registerGet("/api/wellness/mood", "Mood history", "wellness");
registerGet("/api/wellness/mood/stats", "Mood stats, streaks & factor correlation", "wellness");
registerBody("/api/wellness/journal", "post", JournalEntrySchema.shape.body, "Create a journal entry");
registerGet("/api/wellness/journal", "Journal entries", "wellness");
registerBody("/api/wellness/journal/{id}", "put", JournalEntrySchema.shape.body, "Edit your journal entry");
registry.registerPath({
    method: "delete",
    path: "/api/wellness/journal/{id}",
    summary: "Delete your journal entry",
    tags: ["wellness"],
    responses: { 200: { description: "Success" }, 404: { description: "Not found" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});
registerBody("/api/wellness/journal/summarize", "post", z.object({}), "AI summary of recent journal entries");
registerBody("/api/wellness/assessments", "post", SubmitAssessmentSchema.shape.body, "Submit a PHQ-9 / GAD-7 screening");
registerGet("/api/wellness/assessments", "Assessment history", "wellness");

// Messages
registerGet("/api/messages/conversations", "Conversation list", "messages");
registerGet("/api/messages/{userId}/messages", "Message thread with a user", "messages");
registerBody("/api/messages/{userId}", "post", SendMessageSchema.shape.body, "Send a message (optionally with attachment)");
registerBody("/api/messages/{userId}/typing", "post", TypingSchema.shape.body, "Send a typing indicator");
registerBody("/api/messages/upload", "post", z.object({}), "Upload a chat attachment (multipart)");
registry.registerPath({
    method: "delete",
    path: "/api/messages/{id}",
    summary: "Soft-delete your own message",
    tags: ["messages"],
    responses: { 200: { description: "Success" }, 403: { description: "Not your message" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});
registerBody("/api/messages/{id}/reaction", "put", z.object({ reaction: z.string().nullable() }), "Set or clear a message reaction");

// AI
registerBody("/api/ai/pre-session", "post", GenerateQuestionsSchema.shape.body, "Generate pre-session questions");
registerBody("/api/ai/pre-session/answers", "post", SubmitAnswersSchema.shape.body, "Submit pre-session answers");
registerGet("/api/ai/pre-session/{appointmentId}", "Get pre-session data", "ai");
registerBody("/api/ai/briefing", "post", GenerateBriefingSchema.shape.body, "Generate doctor briefing");
registerGet("/api/ai/briefing/{appointmentId}", "Get cached briefing", "ai");
registerBody("/api/ai/resources", "post", z.object({}), "Personalized wellness suggestions");
registerBody("/api/ai/match-doctors", "post", MatchDoctorsSchema.shape.body, "Natural-language doctor matching");

// Notifications & Admin
registerGet("/api/notifications", "Notification list", "notifications");
registerGet("/api/notifications/unread-count", "Unread count", "notifications");
registerGet("/api/notifications/preferences", "Notification preferences", "notifications");
registerBody("/api/notifications/preferences", "put", z.object({ appointment: z.boolean(), message: z.boolean(), system: z.boolean() }), "Update notification preferences");
registerGet("/api/admin/stats", "System stats", "admin");
registerGet("/api/admin/users", "Paginated user list", "admin");
registerGet("/api/admin/audit-logs", "Audit log trail", "admin");
registerGet("/api/admin/review-reports", "Open review reports", "admin");
registerBody("/api/admin/reviews/{id}/hide", "post", z.object({}), "Hide a review from public profiles");
registerBody("/api/admin/review-reports/{id}/status", "post", z.object({ status: z.enum(["resolved", "dismissed"]) }), "Resolve or dismiss a review report");
registerGet("/api/admin/export/{kind}", "CSV export (bookings|users|revenue)", "admin");
registerGet("/api/admin/doctors/applications", "Doctor verification applications", "admin");
registerBody("/api/admin/doctors/{id}/verification", "patch", z.object({ status: z.enum(["approved", "rejected"]) }), "Approve or reject a doctor application");
registerBody("/api/admin/users/{id}/role", "patch", z.object({ role: z.enum(["patient", "doctor", "admin"]) }), "Change user role");
registerBody("/api/admin/users/{id}/ban", "patch", z.object({}), "Toggle user ban");

// Support (authenticated — anonymous calls are rejected)
registerBody("/api/support/chat", "post", z.object({ message: z.string(), history: z.array(z.object({ role: z.string(), content: z.string() })).optional() }), "AI support assistant with crisis routing & escalation");
registerBody("/api/support/sos", "post", z.object({}), "SOS panic button (alerts assigned doctor + crisis hotlines)");

// Waitlist, packages, away mode, push
registerBody("/api/doctors/{id}/waitlist", "post", z.object({}), "Join a doctor's waitlist");
registry.registerPath({
    method: "delete",
    path: "/api/doctors/{id}/waitlist",
    summary: "Leave the waitlist",
    tags: ["doctors"],
    responses: { 200: { description: "Success" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});
registerGet("/api/doctors/{id}/waitlist/status", "Waitlist status for the current patient", "doctors");
registerGet("/api/doctors/{id}/packages", "Doctor's therapy packages", "doctors", false);
registerBody("/api/doctors/packages", "post", z.object({ name: z.string(), sessionCount: z.number(), totalPrice: z.number() }), "Create a package (doctor)");
registerBody("/api/packages/{id}/purchase", "post", z.object({}), "Purchase a package (patient)");
registerGet("/api/packages/my", "My package purchases", "doctors");
registerBody("/api/doctors/away", "post", z.object({ awayUntil: z.string().nullable() }), "Toggle away mode (doctor)");
registerBody("/api/doctors/patterns/{id}/regenerate", "post", z.object({}), "Regenerate missed pattern weeks");
registerGet("/api/push/public-key", "VAPID public key", "push");
registerBody("/api/push/subscribe", "post", z.object({ endpoint: z.string(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }), "Register a web-push subscription");
registerBody("/api/push/unsubscribe", "post", z.object({ endpoint: z.string() }), "Remove a web-push subscription");

// Profile
registerGet("/api/users/profile", "Current profile (includes doctorProfile, sessionCredits, referralCode)", "users");
registerBody("/api/users/profile", "put", z.object({}), "Update profile (multipart: avatar file + name, phone_number, bio, specialization, consultation_fee, license_number, license_issuer, experience_years)");

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
