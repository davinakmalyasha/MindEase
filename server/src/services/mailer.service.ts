import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const FROM_EMAIL = process.env.SMTP_FROM || "MindEase <no-reply@mindease.app>";

let transporter: nodemailer.Transporter | null = null;

const getTransporter = () => {
    if (transporter) return transporter;
    if (process.env.SMTP_HOST) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || "587"),
            secure: process.env.SMTP_SECURE === "true",
            auth: {
                user: process.env.SMTP_USER || "",
                pass: process.env.SMTP_PASS || "",
            },
        });
    }
    return transporter;
};

export const MailerService = {
    async send(to: string, subject: string, html: string) {
        const transport = getTransporter();
        if (!transport) {
            // Dev fallback: no SMTP configured — log the email body
            console.log(`\n[MAIL:${to}] ${subject}\n${html.replace(/<[^>]+>/g, "")}\n`);
            return { devFallback: true };
        }
        return await transport.sendMail({
            from: FROM_EMAIL,
            to,
            subject,
            html,
        });
    },

    buildOtpEmail(otp: string): { subject: string; html: string } {
        return {
            subject: "Your MindEase password reset code",
            html: `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2 style="color:#4f46e5">MindEase</h2>
  <p>We received a request to reset your password. Use the code below — it expires in 10 minutes.</p>
  <div style="font-size:28px;font-weight:bold;letter-spacing:8px;padding:16px;background:#eef2ff;border-radius:8px;text-align:center">${otp}</div>
  <p style="color:#64748b;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
</div>`,
        };
    },
};
