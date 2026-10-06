import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { logger } from "../utils/logger";

dotenv.config();

const FROM_EMAIL = process.env.SMTP_FROM || "MindEase <no-reply@mindease.app>";
const IS_PROD = process.env.NODE_ENV === "production";

// User-controlled values (names, notes, titles) must never reach email HTML
// unescaped — they would allow markup/script injection into recipients' mail.
const esc = (v: unknown) =>
    String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

// Scrub a value before it goes into a log entry.
//
// `to` and `subject` are user-controlled, and a log line is a format: a value
// containing a newline forges a second line, and one containing an ANSI escape
// sequence can retype the terminal of whoever is reading it. Neither is
// hypothetical, and both are cheap to prevent.
//
// Truncated as well, because an unbounded user-controlled string in a log line is
// a log-volume problem as well as a safety one.
const forLog = (v: unknown): string => {
    const raw = String(v ?? "");
    // eslint-disable-next-line no-control-regex
    const scrubbed = raw.replace(/[\r\n\u0000-\u001F\u007F]/g, " ");
    return scrubbed.length > 200 ? `${scrubbed.slice(0, 200)}...` : scrubbed;
};

// `ReturnType<typeof createTransport>` rather than the old `nodemailer.Transporter`.
//
// nodemailer 10 removed the `Transporter` type and replaced it with a generic
// `Mail<SentMessageInfo, Options>`: the return type now depends on which transport
// you asked for, so there is no single `Transporter` name to reference. Deriving
// the type from the function means this annotation is correct for whichever
// transport is configured here, and it will not break again on the next major -
// which is what upgrading to 10 to pick up the TLS servername advisory fix did.
type Transporter = ReturnType<typeof nodemailer.createTransport>;

let transporter: Transporter | null = null;
let smtpConfigured = false;

const getTransporter = () => {
    if (transporter) return transporter;
    if (process.env.SMTP_HOST) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || "587", 10),
            secure: process.env.SMTP_SECURE === "true",
            auth: {
                user: process.env.SMTP_USER || "",
                pass: process.env.SMTP_PASS || "",
            },
        });
        smtpConfigured = true;
    }
    return transporter;
};

// Boot-time diagnostics: surface SMTP misconfiguration early instead of at
// first password reset.
export const checkMailerStatus = () => {
    if (smtpConfigured || process.env.SMTP_HOST) {
        return {
            configured: true,
            host: process.env.SMTP_HOST,
            mode: IS_PROD ? "production (real delivery)" : "development (real delivery)",
        };
    }
    return {
        configured: false,
        mode: IS_PROD
            ? "PRODUCTION WITHOUT SMTP — password reset & email verification will FAIL"
            : "development (emails printed to console)",
    };
};

export const MailerService = {
    async send(to: string, subject: string, html: string, devCode?: string) {
        const transport = getTransporter();
        if (!transport) {
            if (IS_PROD) {
                // Fail loudly: silently dropping verification/reset emails in
                // production is worse than a visible error.
                throw new Error(
                    "SMTP is not configured (SMTP_HOST missing) but NODE_ENV=production. " +
                        "Password reset and email verification are disabled."
                );
            }
            // Dev fallback: no SMTP configured. Log what a developer needs - the recipient,
// the subject and the code - and nothing else.
            //
            // It used to log `html.replace(/<[^>]+>/g, "")`, and CodeQL found three
            // separate problems on that one expression: the regex is not a
            // sufficient HTML sanitiser (`<!--` survives it, so an HTML comment
            // opener can still reach a log viewer that renders it), it is flagged
            // as a polynomial expression over attacker-controlled input, and the
            // `to` and `subject` beside it are user-controlled values written into
            // a log entry, which is log injection - a crafted address containing a
            // newline can forge a second log line.
            //
            // None of that is fixed by a better regular expression. The caller
            // already knows the code, so it passes it, and the values written to
            // the log are scrubbed of anything that could structure it.
            logger.warn(
                {
                    to: forLog(to),
                    subject: forLog(subject),
                    devCode: devCode ? forLog(devCode) : undefined,
                    devFallback: true,
                },
                "[MAIL] SMTP not configured; no message was sent. Code above, if any."
            );
            return { devFallback: true };
        }
        return await transport.sendMail({
            from: FROM_EMAIL,
            to,
            subject,
            html,
        });
    },

    buildOtpEmail(otp: string, purpose: "reset" | "verify"): { subject: string; html: string } {
        const isReset = purpose === "reset";
        const subject = isReset ? "Your MindEase password reset code" : "Verify your MindEase email";
        const body = isReset
            ? "We received a request to reset your password. Use the code below — it expires in 10 minutes."
            : "Confirm your email address with this code — it expires in 10 minutes.";
        const footer = isReset
            ? "If you didn't request this, you can safely ignore this email."
            : "If you didn't create a MindEase account, you can safely ignore this email.";
        return {
            subject,
            html: `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2 style="color:#4f46e5">MindEase</h2>
  <p>${body}</p>
  <div style="font-size:28px;font-weight:bold;letter-spacing:8px;padding:16px;background:#eef2ff;border-radius:8px;text-align:center">${otp}</div>
  <p style="color:#64748b;font-size:13px">${footer}</p>
</div>`,
        };
    },

    buildBookingReceivedEmail(data: {
        doctorName: string;
        patientName: string;
        date: string;
        time: string;
        type: string;
        notes?: string | null;
    }): { subject: string; html: string } {
        return {
            subject: "New session request — MindEase",
            html: `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2 style="color:#4f46e5">MindEase</h2>
  <p>Hi ${esc(data.doctorName)},</p>
  <p><strong>${esc(data.patientName)}</strong> requested a session:</p>
  <div style="background:#f8fafc;border-radius:8px;padding:16px;margin:16px 0">
    <p style="margin:4px 0"><strong>Date:</strong> ${esc(data.date)}</p>
    <p style="margin:4px 0"><strong>Time:</strong> ${esc(data.time)}</p>
    <p style="margin:4px 0"><strong>Mode:</strong> ${esc(data.type)}</p>
    ${data.notes ? `<p style="margin:4px 0"><strong>Notes:</strong> ${esc(data.notes)}</p>` : ""}
  </div>
  <p style="color:#64748b;font-size:13px">Review and confirm the request from your MindEase dashboard.</p>
</div>`,
        };
    },

    buildBookingConfirmedEmail(data: {
        patientName: string;
        doctorName: string;
        date: string;
        time: string;
        type: string;
    }): { subject: string; html: string } {
        return {
            subject: "Your session is confirmed — MindEase",
            html: `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2 style="color:#4f46e5">MindEase</h2>
  <p>Hi ${esc(data.patientName)},</p>
  <p>Your session with <strong>${esc(data.doctorName)}</strong> has been confirmed:</p>
  <div style="background:#f8fafc;border-radius:8px;padding:16px;margin:16px 0">
    <p style="margin:4px 0"><strong>Date:</strong> ${esc(data.date)}</p>
    <p style="margin:4px 0"><strong>Time:</strong> ${esc(data.time)}</p>
    <p style="margin:4px 0"><strong>Mode:</strong> ${esc(data.type)}</p>
  </div>
  <p>Complete your pre-session reflections before the session so your doctor can prepare.</p>
  <p style="color:#64748b;font-size:13px">In crisis? Call 112 (Indonesia) or see our crisis hotlines.</p>
</div>`,
        };
    },

    buildReminderEmail(data: {
        name: string;
        counterpartName: string;
        date: string;
        time: string;
        type: string;
        isPatient: boolean;
    }): { subject: string; html: string } {
        const roleLabel = data.isPatient ? "your session" : "a session with a patient";
        return {
            subject: `Reminder: ${esc(data.date)} — MindEase session`,
            html: `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2 style="color:#4f46e5">MindEase</h2>
  <p>Hi ${esc(data.name)},</p>
  <p>A friendly reminder about ${roleLabel}:</p>
  <div style="background:#f8fafc;border-radius:8px;padding:16px;margin:16px 0">
    <p style="margin:4px 0"><strong>Date:</strong> ${esc(data.date)}</p>
    <p style="margin:4px 0"><strong>Time:</strong> ${esc(data.time)}</p>
    <p style="margin:4px 0"><strong>Mode:</strong> ${esc(data.type)}</p>
  </div>
  <p style="color:#64748b;font-size:13px">${data.isPatient ? "In crisis? Call 112 (Indonesia) or see our crisis hotlines." : "You can message the patient through the MindEase dashboard."}</p>
</div>`,
        };
    },

    buildApprovalEmail(data: {
        doctorName: string;
        approved: boolean;
    }): { subject: string; html: string } {
        const approved = data.approved;
        return {
            subject: approved ? "Welcome to MindEase — profile approved" : "Update on your MindEase application",
            html: `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2 style="color:#4f46e5">MindEase</h2>
  ${approved
        ? `<p>Hi ${esc(data.doctorName)},</p>
  <p>Great news — your psychologist profile has been <strong>approved</strong>! Patients can now find and book sessions with you.</p>
  <p>Set up your availability slots from your dashboard to start receiving bookings.</p>`
        : `<p>Hi ${esc(data.doctorName)},</p>
  <p>Thank you for applying to join MindEase. After review, we were unable to approve your profile at this time.</p>
  <p>If you believe this was a mistake, contact us at support@mindease.id.</p>`}
  <p style="color:#64748b;font-size:13px">— The MindEase team</p>
</div>`,
        };
    },

    buildWeeklyReportEmail(data: {
        name: string;
        averageMood: number;
        streak: number;
        trend: string;
        journalCount: number;
        aiSummary: string | null;
    }): { subject: string; html: string } {
        return {
            subject: "Your MindEase weekly wellness report",
            html: `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2 style="color:#4f46e5">MindEase</h2>
  <p>Hi ${esc(data.name)},</p>
  <p>Here's your wellness summary for this week:</p>
  <div style="background:#f8fafc;border-radius:8px;padding:16px;margin:16px 0">
    <p style="margin:4px 0"><strong>30-day average mood:</strong> ${data.averageMood}/5</p>
    <p style="margin:4px 0"><strong>Log streak:</strong> ${data.streak} days</p>
    <p style="margin:4px 0"><strong>Trend:</strong> ${data.trend}</p>
    <p style="margin:4px 0"><strong>Journal entries this week:</strong> ${data.journalCount}</p>
  </div>
  ${data.aiSummary ? `<div style="background:#eef2ff;border-radius:8px;padding:16px;margin:16px 0"><p style="margin:0;font-style:italic">${esc(data.aiSummary)}</p></div>` : ""}
  <p style="color:#64748b;font-size:13px">Keep logging your mood daily — small steps make a difference.</p>
  <p style="color:#64748b;font-size:13px">In crisis? Call 112 (Indonesia) or see our crisis hotlines.</p>
</div>`,
        };
    },

    buildNotificationEmail(data: {
        title: string;
        message: string;
        type: string;
    }): { subject: string; html: string } {
        return {
            subject: `${esc(data.title)} — MindEase`,
            html: `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2 style="color:#4f46e5">MindEase</h2>
  <p style="font-weight:bold;margin:0 0 8px">${esc(data.title)}</p>
  <div style="background:#f8fafc;border-radius:8px;padding:16px;margin:8px 0">
    <p style="margin:0;color:#475569">${esc(data.message)}</p>
  </div>
  <p style="color:#64748b;font-size:13px">Open your dashboard to view details. You can adjust these email notifications anytime in Profile — Notification preferences.</p>
</div>`,
        };
    },
};
