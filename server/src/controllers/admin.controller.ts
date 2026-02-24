import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class AdminController {
    static async getStats(req: Request, res: Response) {
        try {
            const totalPatients = await prisma.user.count({ where: { role: "patient" } });
            const totalDoctors = await prisma.user.count({ where: { role: "doctor" } });
            const successfulBookings = await prisma.appointment.count({ where: { status: "completed" } });

            // Basic revenue calculation: sum of completed appointment doctor prices (assuming doctor price is the fee)
            const revenueResult = await prisma.appointment.findMany({
                where: { status: "completed" },
                include: { doctor: true }
            });

            const totalEstimatedRevenue = revenueResult.reduce((sum, app) => sum + (app.doctor.price || 0), 0);

            res.json({
                total_patients: totalPatients,
                total_doctors: totalDoctors,
                successful_bookings: successfulBookings,
                total_estimated_revenue: totalEstimatedRevenue
            });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async getUsers(req: Request, res: Response) {
        try {
            const users = await prisma.user.findMany({
                select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true,
                    createdAt: true
                },
                orderBy: { createdAt: "desc" }
            });
            res.json(users);
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }
}
