import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
    RegisterSchema,
    LoginSchema,
    ChangePasswordSchema,
    ForgotPasswordSchema,
    ResetPasswordSchema,
} from "../schemas/auth.schema";
import {
    BookAppointmentSchema,
    UpdateStatusSchema,
    CreateSlotSchema,
    CreatePatternSchema,
    SuggestFollowUpSchema,
    RescheduleSchema,
} from "../schemas/appointment.schema";
import { CreateReviewSchema, LogMoodSchema, JournalEntrySchema, SubmitAssessmentSchema, ReplyReviewSchema, ReportReviewSchema } from "../schemas/wellness.schema";
import { SendMessageSchema, TypingSchema } from "../schemas/message.schema";
import { GenerateQuestionsSchema, SubmitAnswersSchema, GenerateBriefingSchema, MatchDoctorsSchema } from "../schemas/ai.schema";
import { ResolveRiskAlertSchema } from "../schemas/wellness.schema";
import {
    UpdateCarePlanSchema,
    CreateGoalSchema,
    UpdateGoalSchema,
    CreateStepSchema,
    SetStepDoneSchema,
    SaveSafetyPlanSchema,
} from "../schemas/carePlan.schema";

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
// The real route is a DELETE. A POST was also registered here with the comment
// "delete shown as post workaround", which documented an endpoint that does not
// exist and would have sent a generated client to a 404. Only the DELETE below
// is real.
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
// Multipart, not JSON. The avatar and attachment uploads are declared as
// `application/json` elsewhere in this file, which tells a generated client to
// send JSON to a route running `multer` - the request would arrive with no
// file and fail on the server for a reason the client cannot see.
const registerMultipart = (path: string, summary: string, security = true) => {
    registry.registerPath({
        method: "post",
        path,
        summary,
        tags: [path.split("/")[2] || "api"],
        request: {
            body: {
                content: {
                    "multipart/form-data": {
                        schema: z.object({ file: z.string().describe("Binary upload") }).passthrough(),
                    },
                },
            },
        },
        responses: {
            200: { description: "Success" },
            400: { description: "Rejected: extension, MIME type or size" },
            401: { description: "Unauthorized" },
        },
        security: security ? [{ cookieAuth: [], csrfToken: [] }] : undefined,
    });
};

registerMultipart("/api/messages/upload", "Upload a chat attachment (multipart/form-data)");
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
// The real shape is a per-category object of per-channel booleans, and the
// schema is `.strict()`. The spec previously declared three flat booleans,
// which a generated client would send - and `.strict()` would reject with a 400,
// because the channel dimension was missing. Declaring the actual shape is the
// only thing that makes a generated client work against this endpoint.
const channelPrefs = z
    .object({ inApp: z.boolean().optional(), email: z.boolean().optional() })
    .optional();
registerBody(
    "/api/notifications/preferences",
    "put",
    z.object({
        appointment: channelPrefs,
        message: channelPrefs,
        system: channelPrefs,
    }),
    "Update notification preferences, per category and per channel"
);
registry.registerPath({
    method: "patch",
    path: "/api/notifications/{id}/read",
    summary: "Mark one notification read",
    tags: ["notifications"],
    responses: { 200: { description: "Success" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});
registry.registerPath({
    method: "patch",
    path: "/api/notifications/read-all",
    summary: "Mark every notification read",
    tags: ["notifications"],
    responses: { 200: { description: "Success" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});
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
// Packages are bought through the doctor resource. The spec previously
// documented `/api/packages/{id}/purchase` and `/api/packages/my`, neither of
// which exists - both are under `/api/doctors`. A client generated from the old
// spec called a 404 and then a 404 on its own purchases list.
registerBody("/api/doctors/packages/{id}/purchase", "post", z.object({}), "Purchase a package (patient)");
registerGet("/api/doctors/packages/my", "My package purchases", "payments");
registerBody("/api/doctors/away", "post", z.object({ awayUntil: z.string().nullable() }), "Toggle away mode (doctor)");
registerBody("/api/doctors/patterns/{id}/regenerate", "post", z.object({}), "Regenerate missed pattern weeks");
registry.registerPath({
    method: "delete",
    path: "/api/doctors/slots/{id}",
    summary: "Delete an unbooked slot",
    tags: ["doctors"],
    responses: { 200: { description: "Success" }, 400: { description: "Slot not found or already booked" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});
registry.registerPath({
    method: "delete",
    path: "/api/doctors/packages/{id}",
    summary: "Delete one of your own packages",
    tags: ["doctors"],
    responses: { 200: { description: "Success" }, 403: { description: "Not your package" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});
registerGet("/api/push/public-key", "VAPID public key", "push");
registerBody("/api/push/subscribe", "post", z.object({ endpoint: z.string(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }), "Register a web-push subscription");
registerBody("/api/push/unsubscribe", "post", z.object({ endpoint: z.string() }), "Remove a web-push subscription");

// Profile
registerGet("/api/users/profile", "Current profile (includes doctorProfile, sessionCredits, referralCode)", "users");
// Multipart, not JSON - see registerMultipart above.
registry.registerPath({
    method: "put",
    path: "/api/users/profile",
    summary: "Update profile",
    description:
        "multipart/form-data. A doctor may also submit license_number, license_issuer, education, languages and experience_years here; these are surfaced to patients on the public profile, labelled as the clinician's own statement.",
    tags: ["users"],
    request: {
        body: {
            content: {
                "multipart/form-data": {
                    schema: z
                        .object({
                            avatar: z.string().optional().describe("Binary image, max 2MB"),
                            name: z.string().optional(),
                            phone_number: z.string().optional(),
                        })
                        .passthrough(),
                },
            },
        },
    },
    responses: { 200: { description: "Success" }, 400: { description: "Validation error" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});

// Health
registerGet("/api/health", "Liveness check", "system", false);
registerGet("/api/health/db", "DB readiness check", "system", false);
registerGet("/api/csrf-token", "Obtain CSRF token", "system", false);

// ---------------------------------------------------------------------------
// Account & two-factor
//
// 2FA verification is the step that completes a login for a user with the
// factor enabled. It was absent from the spec entirely, which made the login
// flow impossible to follow from the documentation: the natural question after
// POST /api/auth/login returns a pending token is "and then what", and the
// answer was not here.
// ---------------------------------------------------------------------------
registerGet("/api/account/2fa/setup", "Begin TOTP enrolment", "account");
registerBody("/api/account/2fa/enable", "post", z.object({ code: z.string() }), "Enable TOTP with a valid code");
registerBody("/api/account/2fa/disable", "post", z.object({ password: z.string() }), "Disable TOTP");
registerBody("/api/account/2fa/verify", "post", z.object({ code: z.string() }), "Complete a login by verifying a TOTP code");
registerBody("/api/account/change-password", "post", ChangePasswordSchema.shape.body, "Change your password");
registerGet("/api/account/export", "Export everything we hold about you (GDPR portability)", "account");
registry.registerPath({
    method: "delete",
    path: "/api/account/me",
    summary: "Delete your account",
    description:
        "Anonymises rather than deletes. Clinical safety records (RiskAlert) are retained in anonymised form: the fact that a screening answer triggered a clinician alert is clinically relevant to whoever treats the patient next.",
    tags: ["account"],
    responses: { 200: { description: "Success" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});
registerBody("/api/account/forgot-password", "post", ForgotPasswordSchema.shape.body, "Request a password reset code", false);
registerBody("/api/account/reset-password", "post", ResetPasswordSchema.shape.body, "Reset a password with a code", false);
registerBody("/api/account/verify-email", "post", z.object({ code: z.string() }), "Verify your email address", false);

// ---------------------------------------------------------------------------
// Payments
//
// The entire module was missing. It is the one webhook in the API, so its
// absence was the most consequential gap in this file: a generated client had no
// idea a payment callback path existed.
// ---------------------------------------------------------------------------
registerGet("/api/payments/config", "Active payment provider and publishable key", "payments");
registerGet("/api/payments/purchases", "Your package purchases", "payments");
registerGet("/api/payments/purchases/{id}", "One purchase", "payments");
registerBody("/api/payments/packages/{id}/checkout", "post", z.object({}), "Start a checkout and get a redirect URL");
// Registered without security and without CSRF: a provider callback cannot
// present a session cookie or a CSRF token. The handler verifies the provider
// signature and the amount against the stored order before granting anything.
registry.registerPath({
    method: "post",
    path: "/api/payments/notification",
    summary: "Provider payment callback (webhook)",
    description:
        "Called by the payment provider. No session and no CSRF token: a provider cannot present either. Authenticated by provider signature instead, and the amount is re-checked against the stored order before an entitlement is granted.",
    tags: ["payments"],
    request: { body: { content: { "application/json": { schema: z.object({}).passthrough() } } } },
    responses: { 200: { description: "Accepted" }, 400: { description: "Signature or amount mismatch" } },
});

// ---------------------------------------------------------------------------
// Realtime
//
// Without this the WebSocket handshake is undiscoverable: a client reading the
// spec has no way to learn that a short-lived ticket must be fetched first.
// ---------------------------------------------------------------------------
registerBody("/api/realtime/ticket", "post", z.object({}), "Mint a short-lived WebSocket ticket");

// ---------------------------------------------------------------------------
// Clinical safety: the risk queue
//
// The highest-consequence surface in the API, and the one that was undocumented.
// These endpoints return whether a patient disclosed thoughts of self-harm, and
// a client that did not know they existed would never have displayed them.
// ---------------------------------------------------------------------------
registerGet("/api/wellness/risk-alerts", "Clinician triage queue of risk disclosures", "wellness");
registerBody("/api/wellness/risk-alerts/{id}/acknowledge", "post", z.object({}), "Acknowledge a disclosure (records that it was seen)");
registerBody("/api/wellness/risk-alerts/{id}/resolve", "post", ResolveRiskAlertSchema.shape.body, "Resolve a disclosure with a note of what was done");
registerGet("/api/wellness/assessments/trajectory", "Screening trajectory with the instrument's own bands", "wellness");

// ---------------------------------------------------------------------------
// Care plan and safety plan
//
// Patient-owned. Neither is ever generated by a model: a safety plan is a
// document a person may have to read alone, and a care plan is a clinical
// judgement made with them.
// ---------------------------------------------------------------------------
registerGet("/api/care-plan", "Your active care plan (created on first read)", "care-plan");
registerGet("/api/care-plan/all", "Every care plan you have had, closed ones included", "care-plan");
registerBody("/api/care-plan/{id}", "put", UpdateCarePlanSchema.shape.body, "Update your care plan");
registerBody("/api/care-plan/{id}/goals", "post", CreateGoalSchema.shape.body, "Add a goal to a plan");
registerBody("/api/care-plan/goals/{id}", "put", UpdateGoalSchema.shape.body, "Update a goal, including marking it achieved or dropped");
registry.registerPath({
    method: "delete",
    path: "/api/care-plan/goals/{id}",
    summary: "Delete a goal",
    tags: ["care-plan"],
    responses: { 200: { description: "Success" }, 404: { description: "Goal not found" } },
    security: [{ cookieAuth: [], csrfToken: [] }],
});
registerBody("/api/care-plan/goals/{id}/steps", "post", CreateStepSchema.shape.body, "Add a step to a goal");
registerBody("/api/care-plan/steps/{id}", "patch", SetStepDoneSchema.shape.body, "Mark a step done or not done");
registerGet("/api/safety-plan", "Your safety plan, or null if you have not written one", "care-plan");
registerBody("/api/safety-plan", "put", SaveSafetyPlanSchema.shape.body, "Create or replace your safety plan");
registerGet("/api/safety-plan/patient/{id}", "Read a patient's safety plan (clinician)", "care-plan");
registerBody("/api/safety-plan/patient/{id}/reviewed", "post", z.object({}), "Record that you reviewed a plan with the patient");

// Admin
registerBody("/api/admin/broadcast", "post", z.object({ title: z.string(), message: z.string() }), "Send a notification to every user");

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
