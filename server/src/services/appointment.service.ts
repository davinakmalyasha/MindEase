import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class AppointmentService {
    static async createAppointment(data: {
        userId: number;
        doctorId: number;
        appointmentDate: Date;
        startTime: string;
        endTime: string;
        consultationType: string;
        notes?: string;
    }) {
        return await prisma.appointment.create({
            data: {
                userId: data.userId,
                doctorId: data.doctorId,
                appointmentDate: data.appointmentDate,
                startTime: data.startTime,
                endTime: data.endTime,
                consultationType: data.consultationType,
                notes: data.notes,
                status: "pending",
            },
        });
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
            },
            orderBy: {
                appointmentDate: "desc",
            },
        });
    }

    static async getDoctorAppointments(doctorId: number) {
        return await prisma.appointment.findMany({
            where: { doctorId },
            include: {
                user: {
                    select: {
                        name: true,
                        avatar: true,
                        phone_number: true,
                    },
                },
            },
            orderBy: {
                appointmentDate: "desc",
            },
        });
    }

    static async getAppointmentsByRole(user: any) {
        if (user.role === "doctor") {
            const doctor = await prisma.doctor.findUnique({ where: { userId: user.id } });
            if (!doctor) throw new Error("Doctor profile not found");
            return await this.getDoctorAppointments(doctor.id);
        } else {
            return await this.getUserAppointments(user.id);
        }
    }

    static async updateStatus(id: number, status: string) {
        return await prisma.appointment.update({
            where: { id },
            data: { status },
        });
    }
}
