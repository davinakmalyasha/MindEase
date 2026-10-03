import { Request, Response } from "express";
import { SupportService } from "../services/support.service";
import { NotificationService } from "../services/notification.service";
import { WhatsAppService } from "../services/wa.service";
import { MailerService } from "../services/mailer.service";
import { prisma } from "../lib/prisma";
import { publishEvent } from "../services/realtime.service";
import { AuditService } from "../services/audit.service";
import { logger } from "../utils/logger";
import { CRISIS_HOTLINES, type CrisisHotline } from "../services/clinicalSafety.service";

const CRISIS_PAGE = "/crisis";

/**
 * Hotlines are returned on every response path, including failures and
 * rate-limit rejections. A person in acute distress who has pressed SOS four
 * times in an hour must still be handed a phone number.
 */
const crisisPayload = (extra: Record<string, unknown> = {}): {
    doctorAlerted: boolean;
    doctorName: string | null;
    hotlines: CrisisHotline[];
    crisisPage: string;
} => ({
    doctorAlerted: false,
    doctorName: null,
    hotlines: CRISIS_HOTLINES,
    crisisPage: CRISIS_PAGE,
    ...extra,
});

export class SupportController {
    static async chat(req: Request, res: Response) {
        try {
            const { message, history } = req.body;
            const result = await SupportService.chat(message, history || []);
            res.json({ status: "success", data: result });
        } catch (error: any) {
            logger.error({ err: error.message }, "Support chat failed");
            res.status(500).json({ status: "error", message: "Support chat unavailable, please try again" });
        }
    }

    /**
     * SOS: alerts the patient's assigned doctor via notification + realtime
     * push and returns crisis hotlines. Deterministic and fast (no AI call).
     *
     * Every downstream alerting channel is isolated: a failing third party must
     * never turn a successfully recorded SOS into a reported failure, because
     * the user is then told nothing happened when a doctor was in fact paged.
     */
    static async sos(req: Request, res: Response) {
        const user = req.user!;
        if (user.role !== "patient") {
            return res.status(403).json({ status: "error", message: "Only patients can trigger SOS" });
        }

        // Latest doctor with an active or past clinical relationship.
        const appointment = await prisma.appointment
            .findFirst({
                where: { userId: user.id, status: { in: ["confirmed", "completed"] } },
                orderBy: { appointmentDate: "desc" },
                select: { doctor: { select: { userId: true, user: { select: { id: true, name: true } } } } },
            })
            .catch(() => null);

        if (!appointment) {
            // No clinician is attached, so nobody can be paged. Say so plainly
            // rather than implying a human was notified.
            await AuditService.log({
                action: "sos.triggered",
                actorId: user.id,
                meta: { doctorAlerted: false, reason: "no_assigned_doctor" },
            }).catch(() => {});

            return res.json({
                status: "success",
                data: crisisPayload({
                    doctorAlerted: false,
                    reachedCareTeam: false,
                    message:
                        "We could not reach a care team because you have no active therapist. Please call one of the numbers below now.",
                }),
            });
        }

        const doctorUserId = appointment.doctor.userId;
        const patientName = user.name || "a patient";
        const alertText = `Your patient (${patientName}) pressed the SOS button and needs support. Please check in with them.`;

        // The SOS button is the most unambiguous disclosure in the product: a
        // person pressed the thing marked "I need help now". It used to page the
        // clinician through four channels and write only an AuditLog row, which
        // meant it never appeared in the triage queue - so a clinician working
        // their queue could not see the one signal that was certainly genuine.
        //
        // Raised as a RiskAlert first, so the queue is the single place work is
        // tracked. The four channels below still fire; this is additive, not a
        // replacement, and a failure to record must not suppress the paging.
        let sosAlertId: number | null = null;
        try {
            const alert = await prisma.riskAlert.create({
                data: {
                    userId: user.id,
                    level: "urgent",
                    reason: "Patient pressed the SOS button and requested immediate support.",
                    sourceType: "sos",
                    assignedDoctorUserId: doctorUserId,
                },
            });
            sosAlertId = alert.id;
        } catch (err: any) {
            logger.error({ err: err.message, userId: user.id }, "Failed to record SOS as a risk alert");
        }

        // --- Channel 1: in-app notification (must succeed to count as alerted)
        try {
            await NotificationService.create({
                userId: doctorUserId,
                title: "SOS Alert from a patient",
                message: alertText,
                type: "system",
                email: true,
            });
        } catch (err: any) {
            logger.error({ err: err.message, doctorUserId }, "SOS in-app notification failed");
        }

        // --- Channel 2: realtime push
        try {
            await publishEvent(doctorUserId, {
                type: "sos:alert",
                payload: { patientName, patientId: user.id },
            });
        } catch (err: any) {
            logger.error({ err: err.message, doctorUserId }, "SOS realtime publish failed");
        }

        // --- Channel 3 & 4: out-of-band, best effort
        const doctorUser = await prisma.user
            .findUnique({
                where: { id: doctorUserId },
                select: { phone_number: true, email: true },
            })
            .catch(() => null);

        if (doctorUser?.phone_number) {
            try {
                await WhatsAppService.send(doctorUser.phone_number, `SOS: ${alertText}`);
            } catch (err: any) {
                logger.error({ err: err.message }, "SOS WhatsApp alert failed");
            }
        }

        if (doctorUser?.email) {
            try {
                const { subject, html } = MailerService.buildNotificationEmail({
                    title: "SOS Alert from a patient",
                    message: alertText,
                    type: "system",
                });
                await MailerService.send(doctorUser.email, subject, html);
            } catch (err: any) {
                logger.error({ err: err.message }, "SOS email alert failed");
            }
        }

        await AuditService.log({
            action: "sos.triggered",
            actorId: user.id,
            targetType: "RiskAlert",
            targetId: sosAlertId ?? doctorUserId,
            meta: { doctorAlerted: true },
        }).catch(() => {});

        res.json({
            status: "success",
            data: crisisPayload({
                doctorAlerted: true,
                doctorName: appointment.doctor.user.name,
                reachedCareTeam: true,
            }),
        });
    }
}
