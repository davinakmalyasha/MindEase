import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class DoctorService {
    static async getAllDoctors() {
        return await prisma.doctor.findMany({
            include: {
                user: {
                    select: {
                        name: true,
                        avatar: true,
                    },
                },
                reviews: true,
            },
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
                                name: true,
                                avatar: true,
                            },
                        },
                    },
                },
                consultationSlots: {
                    where: {
                        isBooked: false,
                        date: {
                            gte: new Date(),
                        },
                    },
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

        return {
            totalPatients,
            pendingAppointments: pendingAppointments,
            confirmedAppointments: confirmedAppointments,
            totalAppointments: appointments.length,
        };
    }

    static async getSlots(doctorId: number) {
        return await prisma.consultationSlot.findMany({
            where: { doctorId },
            orderBy: { date: "desc" }
        });
    }

    static async createSlot(data: { doctorId: number; date: string; start_time: string; end_time: string }) {
        return await prisma.consultationSlot.create({
            data: {
                doctorId: data.doctorId,
                date: new Date(data.date),
                startTime: data.start_time,
                endTime: data.end_time,
                isBooked: false
            }
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
