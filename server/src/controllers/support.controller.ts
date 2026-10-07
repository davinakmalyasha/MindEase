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

/** Which delivery paths were attempted, and whether each one landed. */
export interface SosDelivery {
    inApp: boolean;
    realtime: boolean;
    whatsapp: boolean;
    email: boolean;
}

/**
 * Turns per-channel outcomes into the single answer the patient is shown.
 *
 * Extracted, and pure, so the rule can be tested directly. The alternative -
 * asserting it by breaking Redis and SMTP inside an integration test - is how
 * this rule ended up wrong in the first place: the previous version returned
 * `true` unconditionally, and no test could have caught that because every
 * channel happened to succeed in the test environment.
 *
 * `realtime` is deliberately excluded. It is fire-and-forget over Redis pub/sub
 * with no backlog and no delivery receipt, so a publish that succeeds while the
 * clinician has no tab open has alerted nobody. Counting it would make the
 * answer depend on the least reliable channel in the set.
 */
export const summariseSosDelivery = (delivered: SosDelivery): { doctorAlerted: boolean } => ({
    doctorAlerted: delivered.inApp || delivered.whatsapp || delivered.email,
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
     *
     * The converse is also handled, and it matters more. `doctorAlerted` is
     * derived from what was actually delivered rather than from the fact that a
     * clinician exists. The previous version returned `true` unconditionally,
     * so an SOS with Redis, SMTP and WhatsApp all down told a patient in acute
     * distress that their care team had been alerted when nobody had been.
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

        // Which channels actually landed.
        //
        // `doctorAlerted` used to be hardcoded true, and it was hardcoded true
        // because an appointment row existed - not because anything was
        // delivered. Four `try/catch` blocks sat above it, each logging and
        // moving on, so Redis down plus SMTP down plus WhatsApp down still
        // returned "your care team has been alerted" to somebody in acute
        // distress, with no durable record either. Each channel is now tracked,
        // and the answer is derived from what happened.
        //
        // Realtime is deliberately excluded from the count. It is fire-and-
        // forget over Redis pub/sub with no backlog, so a publish that succeeds
        // while nobody is connected still alerts nobody. It is best-effort
        // acceleration, not evidence of delivery.
        const delivered = { inApp: false, realtime: false, whatsapp: false, email: false };

        // --- Channel 1: in-app notification (must succeed to count as alerted)
        try {
            await NotificationService.create({
                userId: doctorUserId,
                title: "SOS Alert from a patient",
                message: alertText,
                type: "system",
                email: true,
            });
            delivered.inApp = true;
        } catch (err: any) {
            logger.error({ err: err.message, doctorUserId }, "SOS in-app notification failed");
        }

        // --- Channel 2: realtime push
        try {
            await publishEvent(doctorUserId, {
                type: "sos:alert",
                payload: { patientName, patientId: user.id },
            });
            delivered.realtime = true;
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
                delivered.whatsapp = true;
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
                delivered.email = true;
            } catch (err: any) {
                logger.error({ err: err.message }, "SOS email alert failed");
            }
        }

        // A durable channel is one that leaves a record the clinician will
        // actually see. Realtime does not qualify - see `summariseSosDelivery`.
        const { doctorAlerted } = summariseSosDelivery(delivered);
        const recorded = sosAlertId !== null;

        if (!doctorAlerted || !recorded) {
            // Worth a single loud line rather than four scattered ones: this is
            // the case where a patient pressed SOS and the system did not reach
            // anyone.
            logger.error(
                { userId: user.id, doctorUserId, delivered, recorded },
                "SOS could not confirm delivery to a clinician"
            );
        }

        await AuditService.log({
            action: "sos.triggered",
            actorId: user.id,
            targetType: "RiskAlert",
            targetId: sosAlertId ?? doctorUserId,
            meta: { doctorAlerted, recorded, delivered },
        }).catch(() => {});

        res.json({
            status: "success",
            data: crisisPayload({
                doctorAlerted,
                doctorName: appointment.doctor.user.name,
                reachedCareTeam: doctorAlerted,
                recorded,
                message: doctorAlerted
                    ? `We have alerted ${appointment.doctor.user.name || "your therapist"}. If you are in immediate danger, please call one of the numbers below now.`
                    : "We could not reach your care team just now. Please call one of the numbers below, or contact your therapist directly - they can see this in their queue when the connection recovers.",
            }),
        });
    }
}
