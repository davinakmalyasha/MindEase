import { Request, Response } from "express";
import { AppointmentService } from "../services/appointment.service";
import { NotificationService } from "../services/notification.service";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class AppointmentController {
    static async book(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { doctorId, appointmentDate, startTime, endTime, consultationType, notes, slotId, idempotencyKey } = req.body;

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
                        message: `A patient has booked a session on ${new Date(appointmentDate).toLocaleDateString()} at ${startTime}.`,
                        type: "appointment",
                    });
                }
            } catch (_) { /* non-critical */ }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to book appointment.";
            res.status(400).json({ status: "error", message });
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
            res.status(500).json({ status: "error", message: error.message });
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
                    });
                } else if (status === "cancelled") {
                    const actor = req.user!;
                    if (actor.role === "doctor") {
                        await NotificationService.create({
                            userId: appointment.userId,
                            title: "Appointment Cancelled",
                            message: `Your appointment on ${new Date(appointment.appointmentDate).toLocaleDateString()} was cancelled by the doctor.`,
                            type: "appointment",
                        });
                    } else {
                        const doctor = await prisma.doctor.findUnique({ where: { id: appointment.doctorId } });
                        if (doctor) {
                            await NotificationService.create({
                                userId: doctor.userId,
                                title: "Appointment Cancelled",
                                message: `A patient cancelled their appointment on ${new Date(appointment.appointmentDate).toLocaleDateString()}.`,
                                type: "appointment",
                            });
                        }
                    }
                } else if (status === "completed") {
                    await NotificationService.create({
                        userId: appointment.userId,
                        title: "Session Completed",
                        message: `Your session on ${new Date(appointment.appointmentDate).toLocaleDateString()} is complete. Don't forget to leave a review!`,
                        type: "appointment",
                    });
                }
            } catch (_) { /* non-critical */ }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to update status.";
            res.status(403).json({ status: "error", message });
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
            const message = error instanceof Error ? error.message : "Failed to reschedule appointment.";
            res.status(400).json({ status: "error", message });
        }
    }
}
