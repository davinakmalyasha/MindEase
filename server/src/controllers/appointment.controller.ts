import { Request, Response } from "express";
import { AppointmentService } from "../services/appointment.service";

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
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }
}
