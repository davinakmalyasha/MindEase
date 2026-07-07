import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuditService } from "../services/audit.service";

const prisma = new PrismaClient();

export class AdminController {
    static async getStats(req: Request, res: Response) {
        try {
            const totalPatients = await prisma.user.count({ where: { role: "patient" } });
            const totalDoctors = await prisma.user.count({ where: { role: "doctor" } });
            const successfulBookings = await prisma.appointment.count({ where: { status: "completed" } });
            const pendingAppointments = await prisma.appointment.count({ where: { status: "pending" } });
            const totalAppointments = await prisma.appointment.count();

            const revenueResult = await prisma.appointment.findMany({
                where: { status: "completed" },
                include: { doctor: true },
            });

            const totalEstimatedRevenue = revenueResult.reduce((sum, app) => sum + (app.doctor.price || 0), 0);

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const newUsersToday = await prisma.user.count({
                where: { createdAt: { gte: today } },
            });

            res.json({
                status: "success",
                data: {
                    total_patients: totalPatients,
                    total_doctors: totalDoctors,
                    successful_bookings: successfulBookings,
                    total_estimated_revenue: totalEstimatedRevenue,
                    pending_appointments: pendingAppointments,
                    total_appointments: totalAppointments,
                    new_users_today: newUsersToday,
                },
            });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async getUsers(req: Request, res: Response) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
            const search = (req.query.search as string)?.trim() || "";
            const role = (req.query.role as string) || "";

            const where = {
                ...(search
                    ? {
                          OR: [
                              { name: { contains: search } },
                              { email: { contains: search } },
                          ],
                      }
                    : {}),
                ...(role ? { role } : {}),
            };

            const [users, total] = await Promise.all([
                prisma.user.findMany({
                    where,
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        role: true,
                        isBanned: true,
                        provider: true,
                        createdAt: true,
                    },
                    orderBy: { createdAt: "desc" },
                    skip: (page - 1) * limit,
                    take: limit,
                }),
                prisma.user.count({ where }),
            ]);

            res.json({
                status: "success",
                data: { users, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } },
            });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async updateUserRole(req: Request, res: Response) {
        try {
            const userId = parseInt(req.params.id as string);
            const { role } = req.body;

            if (userId === req.user!.id) {
                return res.status(400).json({ status: "error", message: "Cannot change your own role" });
            }

            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (!user) return res.status(404).json({ status: "error", message: "User not found" });

            const updated = await prisma.user.update({
                where: { id: userId },
                data: { role },
                select: { id: true, name: true, email: true, role: true },
            });

            // Ensure doctor profile exists when promoted to doctor
            if (role === "doctor") {
                await prisma.doctor.upsert({
                    where: { userId },
                    update: {},
                    create: {
                        userId,
                        specialty: "General Psychologist",
                        bio: "Experienced mental health professional.",
                    },
                });
            }

            await AuditService.log({
                action: "user.role_changed",
                actorId: req.user!.id,
                targetType: "User",
                targetId: userId,
                meta: { from: user.role, to: role },
            });

            res.json({ status: "success", data: updated });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async toggleBan(req: Request, res: Response) {
        try {
            const userId = parseInt(req.params.id as string);
            if (userId === req.user!.id) {
                return res.status(400).json({ status: "error", message: "Cannot ban yourself" });
            }

            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (!user) return res.status(404).json({ status: "error", message: "User not found" });

            const updated = await prisma.user.update({
                where: { id: userId },
                data: { isBanned: !user.isBanned },
                select: { id: true, name: true, email: true, role: true, isBanned: true },
            });

            await AuditService.log({
                action: updated.isBanned ? "user.banned" : "user.unbanned",
                actorId: req.user!.id,
                targetType: "User",
                targetId: userId,
            });

            res.json({ status: "success", data: updated });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async getAuditLogs(req: Request, res: Response) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
            const result = await AuditService.getLogs(page, limit);
            res.json({ status: "success", data: result });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }
}
