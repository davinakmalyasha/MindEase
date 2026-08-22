import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { AuditService } from "../services/audit.service";
import { MailerService } from "../services/mailer.service";
import { NotificationService } from "../services/notification.service";
import { ReviewService } from "../services/review.service";
import { invalidateDoctorCache } from "../services/doctor.service";



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

            // Revenue trend: last 12 months of completed bookings + package purchases
            const twelveMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 11, 1);
            const completedForTrend = await prisma.appointment.findMany({
                where: { status: "completed", appointmentDate: { gte: twelveMonthsAgo } },
                include: { doctor: { select: { price: true } } },
            });
            const packagesForTrend = await prisma.packagePurchase.findMany({
                where: { createdAt: { gte: twelveMonthsAgo } },
                include: { package: { select: { totalPrice: true } } },
            });

            const monthly: { key: string; label: string; revenue: number; bookings: number }[] = [];
            for (let i = 11; i >= 0; i--) {
                const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
                monthly.push({ key, label: d.toLocaleDateString("en-GB", { month: "short" }), revenue: 0, bookings: 0 });
            }
            for (const a of completedForTrend) {
                const d = new Date(a.appointmentDate);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
                const m = monthly.find((x) => x.key === key);
                if (m) { m.revenue += a.doctor.price || 0; m.bookings += 1; }
            }
            for (const p of packagesForTrend) {
                const d = new Date(p.createdAt);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
                const m = monthly.find((x) => x.key === key);
                if (m) m.revenue += p.package.totalPrice;
            }

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
                    monthly_revenue: monthly,
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

    static async getDoctorApplications(req: Request, res: Response) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
            const status = (req.query.status as string) || "pending";

            const where = { verificationStatus: status };
            const [doctors, total] = await Promise.all([
                prisma.doctor.findMany({
                    where,
                    include: {
                        user: {
                            select: { id: true, name: true, email: true, avatar: true, phone_number: true, createdAt: true },
                        },
                    },
                    orderBy: { createdAt: "desc" },
                    skip: (page - 1) * limit,
                    take: limit,
                }),
                prisma.doctor.count({ where }),
            ]);

            res.json({
                status: "success",
                data: { applications: doctors, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } },
            });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async updateDoctorVerification(req: Request, res: Response) {
        try {
            const doctorId = parseInt(req.params.id as string);
            const { status } = req.body;

            const doctor = await prisma.doctor.findUnique({
                where: { id: doctorId },
                include: { user: { select: { id: true, name: true, email: true } } },
            });
            if (!doctor) return res.status(404).json({ status: "error", message: "Doctor not found" });

            const updated = await prisma.doctor.update({
                where: { id: doctorId },
                data: { verificationStatus: status },
            });

            invalidateDoctorCache(doctorId);

            await AuditService.log({
                action: `doctor.${status}`,
                actorId: req.user!.id,
                targetType: "Doctor",
                targetId: doctorId,
                meta: { doctorUserId: doctor.userId },
            });

            // Notify + email the doctor about the decision
            const { subject, html } = MailerService.buildApprovalEmail({
                doctorName: doctor.user.name || "Doctor",
                approved: status === "approved",
            });
            await MailerService.send(doctor.user.email, subject, html).catch(() => {});

            res.json({ status: "success", data: { ...updated, user: { id: doctor.user.id, email: doctor.user.email, name: doctor.user.name } } });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async broadcast(req: Request, res: Response) {
        try {
            const { title, message } = req.body;
            const cleanTitle = String(title).trim().slice(0, 255);
            const cleanMessage = String(message).trim().slice(0, 2000);
            if (!cleanTitle || !cleanMessage) {
                return res.status(400).json({ status: "error", message: "Title and message are required" });
            }

            // Batched inserts + per-user realtime/web push (respects in-app prefs)
            const { recipients } = await NotificationService.broadcast(cleanTitle, cleanMessage);

            await AuditService.log({
                action: "admin.broadcast",
                actorId: req.user!.id,
                targetType: "System",
                meta: { recipients, title: cleanTitle },
            });

            res.json({ status: "success", data: { recipients } });
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

    static async getReviewReports(req: Request, res: Response) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
            const status = (req.query.status as string) || "open";
            const [rows, total] = await Promise.all([
                prisma.reviewReport.findMany({
                    where: { status },
                    include: {
                        review: {
                            include: {
                                user: { select: { id: true, name: true } },
                                doctor: { include: { user: { select: { id: true, name: true } } } },
                            },
                        },
                        reporter: { select: { id: true, name: true } },
                    },
                    orderBy: { createdAt: "desc" },
                    skip: (page - 1) * limit,
                    take: limit,
                }),
                prisma.reviewReport.count({ where: { status } }),
            ]);
            res.json({ status: "success", data: { reports: rows, total, page, totalPages: Math.ceil(total / limit) } });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async hideReview(req: Request, res: Response) {
        try {
            const reviewId = parseInt(req.params.id as string);
            const review = await prisma.review.findUnique({ where: { id: reviewId } });
            if (!review) return res.status(404).json({ status: "error", message: "Review not found" });

            await prisma.review.update({
                where: { id: reviewId },
                data: { hidden: true },
            });

            // Hidden reviews must stop influencing the public average
            await ReviewService.recalcDoctorRating(review.doctorId).catch(() => {});

            // Resolve open reports on this review
            await prisma.reviewReport.updateMany({
                where: { reviewId, status: "open" },
                data: { status: "resolved" },
            });

            await AuditService.log({
                action: "admin.review_hidden",
                actorId: req.user!.id,
                targetType: "Review",
                targetId: reviewId,
            });

            res.json({ status: "success", data: { hidden: true } });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async resolveReviewReport(req: Request, res: Response) {
        try {
            const reportId = parseInt(req.params.id as string);
            const { status } = req.body; // resolved | dismissed
            if (!["resolved", "dismissed"].includes(status)) {
                return res.status(400).json({ status: "error", message: "Status must be resolved or dismissed" });
            }

            const report = await prisma.reviewReport.findUnique({ where: { id: reportId } });
            if (!report) return res.status(404).json({ status: "error", message: "Report not found" });

            await prisma.reviewReport.update({
                where: { id: reportId },
                data: { status },
            });

            await AuditService.log({
                action: `admin.report_${status}`,
                actorId: req.user!.id,
                targetType: "ReviewReport",
                targetId: reportId,
                meta: { reviewId: report.reviewId },
            });

            res.json({ status: "success", data: { status } });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async exportCsv(req: Request, res: Response) {
        const escape = (v: unknown) => {
            const s = String(v ?? "");
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(escape).join(",")).join("\n");

        try {
            const kind = req.params.kind as string;

            if (kind === "users") {
                const users = await prisma.user.findMany({
                    where: { isBanned: false },
                    orderBy: { createdAt: "desc" },
                    take: 10000,
                    select: { id: true, name: true, email: true, role: true, provider: true, isBanned: true, createdAt: true },
                });
                const rows: unknown[][] = [["id", "name", "email", "role", "provider", "banned", "createdAt"]];
                for (const u of users) rows.push([u.id, u.name, u.email, u.role, u.provider, u.isBanned, u.createdAt.toISOString()]);
                res.setHeader("Content-Type", "text/csv; charset=utf-8");
                res.setHeader("Content-Disposition", 'attachment; filename="mindease-users.csv"');
                return res.send(toCsv(rows));
            }

            if (kind === "revenue") {
                const doctors = await prisma.doctor.findMany({
                    include: { user: { select: { name: true } } },
                    orderBy: { id: "asc" },
                });
                const appointments = await prisma.appointment.findMany({
                    where: { status: "completed" },
                    select: { doctorId: true, appointmentDate: true },
                });
                const byDoctor = new Map<number, { bookings: number; revenue: number }>();
                for (const a of appointments) {
                    const agg = byDoctor.get(a.doctorId) || { bookings: 0, revenue: 0 };
                    agg.bookings += 1;
                    agg.revenue += 0;
                    byDoctor.set(a.doctorId, agg);
                }
                const rows: unknown[][] = [["doctorId", "doctor", "completedBookings", "revenue", "rate"]];
                for (const d of doctors) {
                    const agg = byDoctor.get(d.id) || { bookings: 0, revenue: 0 };
                    agg.revenue = agg.bookings * d.price;
                    rows.push([d.id, d.user.name || "Doctor", agg.bookings, agg.revenue, d.price]);
                }
                res.setHeader("Content-Type", "text/csv; charset=utf-8");
                res.setHeader("Content-Disposition", 'attachment; filename="mindease-revenue.csv"');
                return res.send(toCsv(rows));
            }

            // default: bookings
            const bookings = await prisma.appointment.findMany({
                orderBy: { createdAt: "desc" },
                take: 10000,
                include: {
                    user: { select: { name: true, email: true } },
                    doctor: { include: { user: { select: { name: true } } } },
                },
            });
            const rows: unknown[][] = [["id", "patient", "patientEmail", "doctor", "date", "time", "type", "status", "price", "createdAt"]];
            for (const a of bookings) {
                rows.push([
                    a.id,
                    a.user.name || "Patient",
                    a.user.email || "",
                    a.doctor.user.name || "Doctor",
                    new Date(a.appointmentDate).toISOString().split("T")[0],
                    `${a.startTime}–${a.endTime}`,
                    a.consultationType,
                    a.status,
                    a.doctor.price,
                    a.createdAt.toISOString(),
                ]);
            }
            res.setHeader("Content-Type", "text/csv; charset=utf-8");
            res.setHeader("Content-Disposition", 'attachment; filename="mindease-bookings.csv"');
            return res.send(toCsv(rows));
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }
}
