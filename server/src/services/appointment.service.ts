import { PrismaClient } from "@prisma/client";
import { sanitize } from "../utils/sanitize";

const prisma = new PrismaClient();

const timeToMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    if (isNaN(h) || isNaN(m)) return NaN;
    return h * 60 + m;
};

const localDateKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const generateMeetingLink = (appointmentId: number) =>
    `https://meet.jit.si/MindEase-${appointmentId}-${Math.random().toString(36).slice(2, 8)}`;

export class AppointmentService {
    static async createAppointment(data: {
        userId: number;
        doctorId: number;
        appointmentDate: Date;
        startTime: string;
        endTime: string;
        consultationType: string;
        notes?: string;
        slotId?: number;
        idempotencyKey?: string;
    }) {
        // Idempotency: replay-safe bookings
        if (data.idempotencyKey) {
            const existing = await prisma.appointment.findUnique({
                where: { idempotencyKey: data.idempotencyKey },
            });
            if (existing) return existing;
        }

        const doctor = await prisma.doctor.findUnique({
            where: { id: data.doctorId },
            include: { user: { select: { id: true } } },
        });
        if (!doctor) throw new Error("Doctor not found");

        const date = new Date(data.appointmentDate);
        if (isNaN(date.getTime())) throw new Error("Invalid appointment date");

        const start = timeToMinutes(data.startTime);
        const end = timeToMinutes(data.endTime);
        if (isNaN(start) || isNaN(end) || start >= end) {
            throw new Error("Invalid appointment time");
        }

        // Block booking in the past
        const now = new Date();
        const slotStart = new Date(date);
        slotStart.setHours(0, 0, 0, 0);
        slotStart.setMinutes(start);
        if (slotStart < now) throw new Error("Cannot book appointments in the past");

        let slotId: number | undefined;

        if (data.slotId) {
            // Lock the slot and verify it belongs to this doctor and is still free
            const slot = await prisma.consultationSlot.findFirst({
                where: { id: data.slotId, doctorId: data.doctorId },
            });
            if (!slot) throw new Error("Slot not found for this doctor");

            if (slot.isBooked) throw new Error("Slot is already booked");
            if (localDateKey(slot.date) !== localDateKey(date)) {
                throw new Error("Slot date does not match appointment date");
            }
            slotId = slot.id;
        }

        // Detect double-booking for the same doctor at the same time
        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const conflict = await prisma.appointment.findFirst({
            where: {
                doctorId: data.doctorId,
                appointmentDate: { gte: dayStart, lt: dayEnd },
                status: { in: ["pending", "confirmed"] },
                OR: [
                    { startTime: { lte: data.startTime }, endTime: { gt: data.startTime } },
                    { startTime: { lt: data.endTime }, endTime: { gte: data.endTime } },
                    { startTime: { gte: data.startTime }, endTime: { lte: data.endTime } },
                ],
            },
        });
        if (conflict) throw new Error("This time is already booked for that doctor");

        const appointment = await prisma.appointment.create({
            data: {
                userId: data.userId,
                doctorId: data.doctorId,
                slotId: slotId ?? null,
                appointmentDate: date,
                startTime: data.startTime,
                endTime: data.endTime,
                consultationType: data.consultationType,
                notes: data.notes ? sanitize(data.notes) : undefined,
                status: "pending",
                idempotencyKey: data.idempotencyKey,
            },
        });

        if (slotId) {
            await prisma.consultationSlot.update({
                where: { id: slotId },
                data: { isBooked: true },
            });
        }

        return appointment;
    }

    static async getUserAppointments(userId: number) {
        return await prisma.appointment.findMany({
            where: { userId },
            include: {
                doctor: {
                    include: {
                        user: {
                            select: {
                                name: true,
                                avatar: true,
                                phone_number: true,
                            },
                        },
                    },
                },
                preSessionData: { select: { answersJson: true, briefingText: true } },
            },
            orderBy: [{ appointmentDate: "desc" }, { startTime: "desc" }],
        });
    }

    static async getDoctorAppointments(doctorId: number) {
        return await prisma.appointment.findMany({
            where: { doctorId },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        avatar: true,
                        phone_number: true,
                    },
                },
                preSessionData: { select: { questionsJson: true, answersJson: true, briefingText: true } },
            },
            orderBy: [{ appointmentDate: "desc" }, { startTime: "desc" }],
        });
    }

    static async getAppointmentsByRole(user: any, page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const take = Math.min(limit, 50);

        if (user.role === "doctor") {
            const doctor = await prisma.doctor.findUnique({ where: { userId: user.id } });
            if (!doctor) throw new Error("Doctor profile not found");
            const [rows, total] = await Promise.all([
                prisma.appointment.findMany({
                    where: { doctorId: doctor.id },
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                avatar: true,
                                phone_number: true,
                            },
                        },
                        preSessionData: { select: { questionsJson: true, answersJson: true, briefingText: true } },
                    },
                    orderBy: [{ appointmentDate: "desc" }, { startTime: "desc" }],
                    skip,
                    take,
                }),
                prisma.appointment.count({ where: { doctorId: doctor.id } }),
            ]);
            return { rows, total, page, totalPages: Math.ceil(total / take) };
        }
        if (user.role === "admin") {
            const [rows, total] = await Promise.all([
                prisma.appointment.findMany({
                    include: {
                        user: { select: { id: true, name: true, avatar: true } },
                        doctor: { include: { user: { select: { name: true } } } },
                    },
                    orderBy: [{ appointmentDate: "desc" }, { startTime: "desc" }],
                    skip,
                    take,
                }),
                prisma.appointment.count(),
            ]);
            return { rows, total, page, totalPages: Math.ceil(total / take) };
        }
        const [rows, total] = await Promise.all([
            prisma.appointment.findMany({
                where: { userId: user.id },
                include: {
                    doctor: {
                        include: {
                            user: {
                                select: {
                                    name: true,
                                    avatar: true,
                                    phone_number: true,
                                },
                            },
                        },
                    },
                    preSessionData: { select: { answersJson: true, briefingText: true } },
                },
                orderBy: [{ appointmentDate: "desc" }, { startTime: "desc" }],
                skip,
                take,
            }),
            prisma.appointment.count({ where: { userId: user.id } }),
        ]);
        return { rows, total, page, totalPages: Math.ceil(total / take) };
    }

    static async updateStatus(id: number, status: string, actor: { id: number; role: string }) {
        const appointment = await prisma.appointment.findUnique({ where: { id } });
        if (!appointment) throw new Error("Appointment not found");

        const ALLOWED = ["confirmed", "cancelled", "completed"];
        if (!ALLOWED.includes(status)) throw new Error("Invalid status");

        if (actor.role === "doctor") {
            const doctor = await prisma.doctor.findUnique({ where: { userId: actor.id } });
            if (!doctor || doctor.id !== appointment.doctorId) {
                throw new Error("Forbidden: not your appointment");
            }
            if (appointment.status === "pending" && status === "completed") {
                throw new Error("Cannot complete a pending appointment");
            }
        } else if (actor.role === "patient") {
            if (appointment.userId !== actor.id) {
                throw new Error("Forbidden: not your appointment");
            }
            if (status !== "cancelled") {
                throw new Error("Patients can only cancel appointments");
            }
            if (appointment.status !== "pending") {
                throw new Error("Only pending appointments can be cancelled by the patient");
            }
        } else if (actor.role === "admin") {
            if (status === "completed") throw new Error("Admins cannot complete appointments");
        } else {
            throw new Error("Unauthorized role");
        }

        const updated = await prisma.appointment.update({
            where: { id },
            data: { status },
        });

        // Attach a meeting link when confirmed
        if (status === "confirmed" && !updated.meetingLink) {
            const link = generateMeetingLink(id);
            await prisma.appointment.update({ where: { id }, data: { meetingLink: link } });
            updated.meetingLink = link;
        }

        // Release the slot when cancelled
        if (status === "cancelled" && updated.slotId) {
            await prisma.consultationSlot.update({
                where: { id: updated.slotId },
                data: { isBooked: false },
            });
        }

        return updated;
    }

    // Patient reschedules: moves the appointment, resets to pending for re-confirmation
    static async reschedule(
        id: number,
        actor: { id: number; role: string },
        data: { appointmentDate: string; startTime: string; endTime: string; slotId?: number }
    ) {
        const appointment = await prisma.appointment.findUnique({ where: { id } });
        if (!appointment) throw new Error("Appointment not found");
        if (appointment.userId !== actor.id) throw new Error("Forbidden: not your appointment");
        if (appointment.status !== "confirmed" && appointment.status !== "pending") {
            throw new Error("Only pending or confirmed appointments can be rescheduled");
        }

        const date = new Date(data.appointmentDate);
        if (isNaN(date.getTime())) throw new Error("Invalid date");
        const start = timeToMinutes(data.startTime);
        const end = timeToMinutes(data.endTime);
        if (isNaN(start) || isNaN(end) || start >= end) throw new Error("Invalid time");

        let slotId: number | undefined;
        if (data.slotId) {
            const slot = await prisma.consultationSlot.findFirst({
                where: { id: data.slotId, doctorId: appointment.doctorId },
            });
            if (!slot) throw new Error("Slot not found for this doctor");
            if (slot.isBooked) throw new Error("Slot is already booked");
            slotId = slot.id;
        }

        // Release the previous slot
        if (appointment.slotId) {
            await prisma.consultationSlot.update({
                where: { id: appointment.slotId },
                data: { isBooked: false },
            });
        }

        const updated = await prisma.appointment.update({
            where: { id },
            data: {
                appointmentDate: date,
                startTime: data.startTime,
                endTime: data.endTime,
                slotId: slotId ?? null,
                status: "pending",
                meetingLink: null,
            },
        });

        if (slotId) {
            await prisma.consultationSlot.update({
                where: { id: slotId },
                data: { isBooked: true },
            });
        }

        return updated;
    }
}
