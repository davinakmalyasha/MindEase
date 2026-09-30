import { Request, Response } from "express";
import { AppointmentService } from "../services/appointment.service";
import { NotificationService } from "../services/notification.service";
import { buildIcs } from "../services/calendar.service";
import { prisma } from "../lib/prisma";
import { publicMessageFor } from "../utils/appError";



export class AppointmentController {
    static async book(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { doctorId, appointmentDate, startTime, endTime, consultationType, notes, slotId, idempotencyKey, packagePurchaseId } = req.body;

            const appointment = await AppointmentService.createAppointment({
                userId,
                doctorId,
                appointmentDate,
                startTime,
                endTime,
                consultationType: consultationType || "video",
                notes,
                slotId,
                idempotencyKey,
                packagePurchaseId,
            });

            res.status(201).json({ status: "success", data: appointment });

            try {
                const doctor = await prisma.doctor.findUnique({
                    where: { id: doctorId },
                    include: { user: { select: { id: true } } },
                });
                if (doctor) {
                    await NotificationService.create({
                        userId: doctor.userId,
                        title: "New Appointment Request",
                        email: true,
                        message: `A patient has booked a session on ${new Date(appointmentDate).toLocaleDateString()} at ${startTime}.`,
                        type: "appointment",
                    });
                }
            } catch (_) { /* non-critical */ }
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to book appointment.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async getMy(req: Request, res: Response) {
        try {
            const user = req.user!;
            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 20;
            const result = await AppointmentService.getAppointmentsByRole(user, page, limit);
            res.json({ status: "success", data: result });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
        }
    }

    static async updateStatus(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (!id) return res.status(400).json({ status: "error", message: "Invalid appointment id" });

            const { status } = req.body;
            const appointment = await AppointmentService.updateStatus(id, status, req.user!);
            res.json({ status: "success", data: appointment });

            // Auto-notify based on status change
            try {
                if (status === "confirmed") {
                    await NotificationService.create({
                        userId: appointment.userId,
                        title: "Appointment Confirmed",
                        message: `Your appointment on ${new Date(appointment.appointmentDate).toLocaleDateString()} at ${appointment.startTime} has been confirmed.`,
                        type: "appointment",
                        email: true,
                    });
                } else if (status === "cancelled") {
                    const actor = req.user!;
                    if (actor.role === "doctor") {
                        await NotificationService.create({
                            userId: appointment.userId,
                            title: "Appointment Cancelled",
                            message: `Your appointment on ${new Date(appointment.appointmentDate).toLocaleDateString()} was cancelled by the doctor. Find an alternative slot from your appointments page.`,
                            type: "appointment",
                            email: true,
                        });
                    } else {
                        const doctor = await prisma.doctor.findUnique({ where: { id: appointment.doctorId } });
                        if (doctor) {
                            await NotificationService.create({
                                userId: doctor.userId,
                                title: "Appointment Cancelled",
                                message: `A patient cancelled their appointment on ${new Date(appointment.appointmentDate).toLocaleDateString()}.`,
                                type: "appointment",
                                email: true,
                            });
                        }
                    }
                } else if (status === "completed") {
                    await NotificationService.create({
                        userId: appointment.userId,
                        title: "Session Completed",
                        message: `Your session on ${new Date(appointment.appointmentDate).toLocaleDateString()} is complete. Don't forget to leave a review!`,
                        type: "appointment",
                        email: true,
                    });
                }
            } catch (_) { /* non-critical */ }
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to update status.", status: 403 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async reschedule(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (!id) return res.status(400).json({ status: "error", message: "Invalid appointment id" });

            const { appointmentDate, startTime, endTime, slotId } = req.body;
            const appointment = await AppointmentService.reschedule(id, req.user!, {
                appointmentDate,
                startTime,
                endTime,
                slotId,
            });

            res.json({ status: "success", data: appointment });

            // Notify the doctor about the reschedule
            try {
                const doctor = await prisma.doctor.findUnique({
                    where: { id: appointment.doctorId },
                    include: { user: { select: { id: true } } },
                });
                if (doctor) {
                    await NotificationService.create({
                        userId: doctor.userId,
                        title: "Appointment Rescheduled",
                        message: `A patient rescheduled their appointment to ${new Date(appointment.appointmentDate).toLocaleDateString()} at ${appointment.startTime}. Please re-confirm.`,
                        type: "appointment",
                    });
                }
            } catch (_) { /* non-critical */ }
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to reschedule appointment.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async joinRoom(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (!id) return res.status(400).json({ status: "error", message: "Invalid appointment id" });

            const room = await AppointmentService.joinRoom(id, req.user!);
            res.json({ status: "success", data: room });
        } catch (error: unknown) {
            // The service throws typed errors, so the status travels with the
            // error. This used to re-derive it by matching message fragments
            // against an allowlist ("Forbidden", "no live room", …), which
            // meant any new client-facing message silently became a 500.
            const { message, status } = publicMessageFor(error) ?? {
                message: "Failed to join room.",
                status: 500,
            };
            res.status(status).json({ status: "error", message });
        }
    }

    static async rebookOptions(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (!id) return res.status(400).json({ status: "error", message: "Invalid appointment id" });

            const options = await AppointmentService.getRebookOptions(id, req.user!);
            res.json({ status: "success", data: options });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? {
                message: "Failed to fetch rebook options.",
                status: 400,
            };
            res.status(status).json({ status: "error", message });
        }
    }

    static async getIcs(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (!id) return res.status(400).json({ status: "error", message: "Invalid appointment id" });

            const appointment = await prisma.appointment.findUnique({
                where: { id },
                include: {
                    user: { select: { name: true } },
                    doctor: { include: { user: { select: { name: true } } } },
                },
            });
            if (!appointment) return res.status(404).json({ status: "error", message: "Appointment not found" });
            if (appointment.status !== "confirmed") {
                return res.status(400).json({ status: "error", message: "Only confirmed appointments can be exported" });
            }

            const isPatient = appointment.userId === req.user!.id;
            const isDoctor = appointment.doctor.userId === req.user!.id;
            if (!isPatient && !isDoctor) {
                return res.status(403).json({ status: "error", message: "Forbidden: not a participant" });
            }

            const start = new Date(appointment.appointmentDate);
            const [sh, sm] = (appointment.startTime || "00:00").split(":").map(Number);
            start.setHours(sh || 0, sm || 0, 0, 0);
            const end = new Date(start);
            const [eh, em] = (appointment.endTime || "00:00").split(":").map(Number);
            end.setHours(eh || 0, em || 0, 0, 0);
            // Sessions crossing midnight produce an earlier DTEND than DTSTART
            if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1);

            const ics = buildIcs({
                summary: `MindEase consultation — ${appointment.consultationType} session`,
                description: `Session with ${isPatient ? appointment.doctor.user.name || "your doctor" : appointment.user.name || "your patient"} (${appointment.consultationType}). ${appointment.meetingLink ? `Join: ${appointment.meetingLink}` : ""}`,
                location: appointment.meetingLink || "Online",
                start,
                end,
                uid: `appointment-${appointment.id}`,
            });

            res.setHeader("Content-Type", "text/calendar; charset=utf-8");
            res.setHeader("Content-Disposition", `attachment; filename="mindease-session-${appointment.id}.ics"`);
            res.send(ics);
        } catch (error: any) {
            res.status(500).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
        }
    }
}
