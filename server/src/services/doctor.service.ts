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
            pendingAppointments,
            confirmedAppointments,
            totalAppointments: appointments.length,
        };
    }
}
