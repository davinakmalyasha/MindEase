import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const timeToMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    if (isNaN(h) || isNaN(m)) return NaN;
    return h * 60 + m;
};

export class DoctorService {
    static async getAllDoctors() {
        return await prisma.doctor.findMany({
            include: {
                user: {
                    select: {
                        name: true,
                        avatar: true,
                        phone_number: true,
                    },
                },
                reviews: true,
            },
            orderBy: { rating: "desc" },
        });
    }

    static async getDoctorById(id: number) {
        return await prisma.doctor.findUnique({
            where: { id },
            include: {
                user: {
                    select: {
                        name: true,
                        avatar: true,
                        role: true,
                        email: true,
                        phone_number: true,
                    },
                },
                reviews: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                avatar: true,
                            },
                        },
                    },
                    orderBy: { createdAt: "desc" },
                },
                consultationSlots: {
                    where: {
                        isBooked: false,
                        date: { gte: new Date() },
                    },
                    orderBy: { date: "asc" },
                },
            },
        });
    }

    static async getDoctorStats(doctorId: number) {
        const appointments = await prisma.appointment.findMany({
            where: { doctorId },
        });

        const totalPatients = new Set(appointments.map((a) => a.userId)).size;
        const pendingAppointments = appointments.filter((a) => a.status === "pending").length;
        const confirmedAppointments = appointments.filter((a) => a.status === "confirmed").length;
        const completedAppointments = appointments.filter((a) => a.status === "completed").length;
        const upcomingAppointments = appointments.filter(
            (a) => a.status === "confirmed" && a.appointmentDate >= new Date()
        ).length;

        return {
            totalPatients,
            pendingAppointments,
            confirmedAppointments,
            completedAppointments,
            upcomingAppointments,
            totalAppointments: appointments.length,
        };
    }

    static async getSlots(doctorId: number) {
        return await prisma.consultationSlot.findMany({
            where: { doctorId },
            orderBy: [{ date: "desc" }, { startTime: "asc" }],
        });
    }

    static async createSlot(data: { doctorId: number; date: string; start_time: string; end_time: string }) {
        const slotDate = new Date(data.date);
        if (isNaN(slotDate.getTime())) throw new Error("Invalid date");

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (slotDate < today) throw new Error("Cannot create slots in the past");

        const start = timeToMinutes(data.start_time);
        const end = timeToMinutes(data.end_time);
        if (isNaN(start) || isNaN(end)) throw new Error("Invalid time format (HH:MM)");
        if (start >= end) throw new Error("End time must be after start time");

        const dayStart = new Date(slotDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const overlapsAny = await prisma.consultationSlot.findFirst({
            where: {
                doctorId: data.doctorId,
                date: { gte: dayStart, lt: dayEnd },
                OR: [
                    { startTime: { lte: data.start_time }, endTime: { gt: data.start_time } },
                    { startTime: { lt: data.end_time }, endTime: { gte: data.end_time } },
                    { startTime: { gte: data.start_time }, endTime: { lte: data.end_time } },
                ],
            },
        });

        if (overlapsAny) throw new Error("Slot overlaps with an existing slot");

        return await prisma.consultationSlot.create({
            data: {
                doctorId: data.doctorId,
                date: slotDate,
                startTime: data.start_time,
                endTime: data.end_time,
                isBooked: false,
            },
        });
    }

    static async deleteSlot(slotId: number, doctorId: number) {
        const slot = await prisma.consultationSlot.findFirst({
            where: { id: slotId, doctorId },
        });

        if (!slot) throw new Error("Slot not found.");
        if (slot.isBooked) throw new Error("Cannot delete a booked slot.");

        return await prisma.consultationSlot.delete({
            where: { id: slotId },
        });
    }
}
