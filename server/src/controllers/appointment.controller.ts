import { Request, Response } from "express";
import { AppointmentService } from "../services/appointment.service";
import { NotificationService } from "../services/notification.service";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class AppointmentController {
    static async book(req: Request, res: Response) {
        try {
            const { doctorId, appointmentDate, startTime, endTime, consultationType, notes } = req.body;
            // @ts-ignore
            const userId = req.user.id;

            const appointment = await AppointmentService.createAppointment({
                userId,
                doctorId,
                appointmentDate: new Date(appointmentDate),
                startTime,
                endTime,
                consultationType,
                notes,
            });

            res.status(201).json({ status: "success", data: appointment });

            // Auto-notify: tell the doctor about the new booking
            try {
                const doctor = await prisma.doctor.findUnique({ where: { id: doctorId }, include: { user: true } });
                if (doctor) {
                    await NotificationService.create({
                        userId: doctor.userId,
                        title: "New Appointment Request",
                        message: `A patient has booked a session on ${new Date(appointmentDate).toLocaleDateString()}.`,
                        type: "appointment",
                    });
                }
            } catch (_) { /* non-critical */ }
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async getMy(req: Request, res: Response) {
        try {
            // @ts-ignore
            const user = req.user;

            console.log(`[Appointments] Fetching for user: ${user.email} (Role: ${user.role})`);

            const appointments = await AppointmentService.getAppointmentsByRole(user);
            console.log(`[Appointments] Found ${appointments.length} records`);

            res.json({ status: "success", data: appointments });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async updateStatus(req: Request, res: Response) {
        try {
            const { status } = req.body;
            const id = req.params.id as string;
            const appointment = await AppointmentService.updateStatus(parseInt(id), status);
            res.json({ status: "success", data: appointment });

            // Auto-notify based on status change
            try {
                if (status === "confirmed") {
                    await NotificationService.create({
                        userId: appointment.userId,
                        title: "Appointment Confirmed",
                        message: `Your appointment on ${new Date(appointment.appointmentDate).toLocaleDateString()} has been confirmed by the doctor.`,
                        type: "appointment",
                    });
                } else if (status === "cancelled") {
                    // Notify the other party
                    const user = (req as any).user;
                    if (user.role === "doctor") {
                        await NotificationService.create({
                            userId: appointment.userId,
                            title: "Appointment Cancelled",
                            message: `Your appointment on ${new Date(appointment.appointmentDate).toLocaleDateString()} has been cancelled by the doctor.`,
                            type: "appointment",
                        });
                    } else {
                        const doctor = await prisma.doctor.findUnique({ where: { id: appointment.doctorId } });
                        if (doctor) {
                            await NotificationService.create({
                                userId: doctor.userId,
                                title: "Appointment Cancelled",
                                message: `A patient has cancelled their appointment on ${new Date(appointment.appointmentDate).toLocaleDateString()}.`,
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
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }
}
