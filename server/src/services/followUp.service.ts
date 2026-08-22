import { prisma } from "../lib/prisma";
import { parseLocalDate } from "../utils/date";
import { NotificationService } from "./notification.service";

export class FollowUpService {
    static async suggest(
        appointmentId: number,
        doctorUserId: number,
        data: { suggestedDate: string; startTime: string; endTime: string; consultationType?: string; notes?: string }
    ) {
        const appointment = await prisma.appointment.findUnique({
            where: { id: appointmentId },
            include: { doctor: { select: { userId: true } } },
        });
        if (!appointment) throw new Error("Appointment not found");
        if (appointment.doctor.userId !== doctorUserId) {
            throw new Error("Forbidden: only the assigned doctor can suggest a follow-up");
        }
        if (appointment.status !== "completed") {
            throw new Error("Follow-ups can only be suggested for completed sessions");
        }

        const existing = await prisma.followUp.findUnique({ where: { appointmentId } });
        if (existing) throw new Error("A follow-up suggestion already exists for this appointment");

        const date = parseLocalDate(data.suggestedDate);
        if (isNaN(date.getTime())) throw new Error("Invalid date");

        const followUp = await prisma.followUp.create({
            data: {
                appointmentId,
                doctorId: appointment.doctorId,
                suggestedDate: date,
                startTime: data.startTime,
                endTime: data.endTime,
                consultationType: data.consultationType || appointment.consultationType,
                notes: data.notes ? data.notes.slice(0, 1000) : null,
            },
        });

        await NotificationService.create({
            userId: appointment.userId,
            title: "Your doctor suggested a follow-up",
            message: `Dr. suggested a follow-up session on ${date.toLocaleDateString("en-GB")} at ${data.startTime}. Accept or decline from your appointments.`,
            type: "appointment",
            email: true,
        });

        return followUp;
    }

    static async get(appointmentId: number, actor: { id: number; role: string }) {
        const appointment = await prisma.appointment.findUnique({
            where: { id: appointmentId },
            include: { doctor: { select: { userId: true } } },
        });
        if (!appointment) throw new Error("Appointment not found");
        const isParticipant =
            appointment.userId === actor.id || (actor.role === "doctor" && appointment.doctor.userId === actor.id);
        if (!isParticipant) throw new Error("Forbidden: not a participant");

        return await prisma.followUp.findUnique({ where: { appointmentId } });
    }

    static async respond(followUpId: number, patientId: number, accept: boolean) {
        const followUp = await prisma.followUp.findUnique({
            where: { id: followUpId },
            include: { appointment: { select: { userId: true } } },
        });
        if (!followUp) throw new Error("Follow-up not found");
        if (followUp.appointment.userId !== patientId) {
            throw new Error("Forbidden: not your appointment");
        }
        if (followUp.status !== "pending") throw new Error("This follow-up was already responded to");

        if (!accept) {
            const updated = await prisma.followUp.update({
                where: { id: followUpId },
                data: { status: "declined" },
            });
            return { followUp: updated, appointment: null };
        }

        // Accept → create a new pending appointment reusing the booking rules
        const appointment = await prisma.appointment.findUnique({
            where: { id: followUp.appointmentId },
            include: { doctor: { select: { id: true, userId: true } } },
        });
        if (!appointment) throw new Error("Appointment not found");

        // Detect conflicts for the same doctor at the same time
        const dayStart = new Date(followUp.suggestedDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        const conflict = await prisma.appointment.findFirst({
            where: {
                doctorId: followUp.doctorId,
                appointmentDate: { gte: dayStart, lt: dayEnd },
                status: { in: ["pending", "confirmed"] },
                OR: [
                    { startTime: { lte: followUp.startTime }, endTime: { gt: followUp.startTime } },
                    { startTime: { lt: followUp.endTime }, endTime: { gte: followUp.endTime } },
                    { startTime: { gte: followUp.startTime }, endTime: { lte: followUp.endTime } },
                ],
            },
        });
        if (conflict) throw new Error("That time is already booked for this doctor — please ask them for another slot");

        const created = await prisma.appointment.create({
            data: {
                userId: patientId,
                doctorId: followUp.doctorId,
                appointmentDate: followUp.suggestedDate,
                startTime: followUp.startTime,
                endTime: followUp.endTime,
                consultationType: followUp.consultationType,
                notes: followUp.notes || "Follow-up session",
                status: "pending",
            },
        });

        await prisma.followUp.update({
            where: { id: followUpId },
            data: { status: "accepted" },
        });

        await NotificationService.create({
            userId: appointment.doctor.userId,
            title: "Follow-up accepted",
            message: `Your patient accepted the follow-up on ${followUp.suggestedDate.toLocaleDateString("en-GB")} at ${followUp.startTime}. Please confirm it.`,
            type: "appointment",
        });

        return { followUp: { ...followUp, status: "accepted" }, appointment: created };
    }
}
