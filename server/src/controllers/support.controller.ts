import { Request, Response } from "express";
import { SupportService } from "../services/support.service";
import { NotificationService } from "../services/notification.service";
import { WhatsAppService } from "../services/wa.service";
import { MailerService } from "../services/mailer.service";
import { prisma } from "../lib/prisma";
import { publishEvent } from "../services/realtime.service";

const CRISIS_HOTLINES = [
    { name: "Emergency (Indonesia)", contact: "112 / 119" },
    { name: "Kemenkes SEJIWA", contact: "119 ext 8" },
    { name: "Halo Kemenkes", contact: "1500-567" },
    { name: "Into The Light (WhatsApp)", contact: "+62 812-123-2012" },
];

export class SupportController {
    static async chat(req: Request, res: Response) {
        try {
            const { message, history } = req.body;
            const result = await SupportService.chat(message, history || []);
            res.json({ status: "success", data: result });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: "Support chat unavailable, please try again" });
        }
    }

    /**
     * SOS: alerts the patient's latest doctor via notification + realtime push
     * and returns crisis hotlines. Deterministic and fast (no AI call).
     */
    static async sos(req: Request, res: Response) {
        try {
            const user = req.user!;
            if (user.role !== "patient") {
                return res.status(403).json({ status: "error", message: "Only patients can trigger SOS" });
            }

            // Latest doctor (confirmed or completed appointment)
            const appointment = await prisma.appointment.findFirst({
                where: { userId: user.id, status: { in: ["confirmed", "completed"] } },
                orderBy: { appointmentDate: "desc" },
                include: {
                    doctor: { include: { user: { select: { id: true, name: true } } } },
                },
            });

            let doctorAlerted = false;
            if (appointment) {
                const doctor = appointment.doctor;
                await NotificationService.create({
                    userId: doctor.user.id,
                    title: "SOS Alert from a patient",
                    message: `Your patient (${user.name || "a patient"}) pressed the SOS button and needs support. Please check in with them.`,
                    type: "system",
                    email: true,
                });
                await publishEvent(doctor.user.id, {
                    type: "sos:alert",
                    payload: {
                        patientName: user.name || "Patient",
                        patientId: user.id,
                    },
                });
                doctorAlerted = true;

                // Hardened alerting: also ping the doctor via WhatsApp when configured
                const doctorUser = await prisma.user.findUnique({
                    where: { id: doctor.user.id },
                    select: { phone_number: true, email: true },
                });
                if (doctorUser?.phone_number) {
                    await WhatsAppService.send(
                        doctorUser.phone_number,
                        `SOS: your patient (${user.name || "a patient"}) pressed the SOS button on MindEase and needs support. Please check in with them as soon as possible.`
                    );
                }
                if (doctorUser?.email) {
                    const { subject, html } = MailerService.buildNotificationEmail({
                        title: "SOS Alert from a patient",
                        message: `Your patient (${user.name || "a patient"}) pressed the SOS button and needs support. Please check in with them as soon as possible.`,
                        type: "system",
                    });
                    MailerService.send(doctorUser.email, subject, html).catch(() => {});
                }
            }

            res.json({
                status: "success",
                data: {
                    doctorAlerted,
                    doctorName: appointment?.doctor.user.name || null,
                    hotlines: CRISIS_HOTLINES,
                    crisisPage: "/crisis",
                },
            });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: "Failed to send SOS. Please call a hotline directly." });
        }
    }
}
