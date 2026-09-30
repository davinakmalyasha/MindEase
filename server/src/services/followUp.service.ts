import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { parseLocalDate, timeToMinutes, overlaps } from "../lib/date";
import { NotificationService } from "./notification.service";
import { badRequest, conflict, forbidden, notFound } from "../utils/appError";

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
        if (!appointment) throw notFound("Appointment not found");
        if (appointment.doctor.userId !== doctorUserId) {
            throw forbidden("only the assigned doctor can suggest a follow-up");
        }
        if (appointment.status !== "completed") {
            throw badRequest("Follow-ups can only be suggested for completed sessions");
        }

        const existing = await prisma.followUp.findUnique({ where: { appointmentId } });
        if (existing) throw conflict("A follow-up suggestion already exists for this appointment");

        const date = parseLocalDate(data.suggestedDate);
        if (isNaN(date.getTime())) throw badRequest("Invalid date");

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
        if (!appointment) throw notFound("Appointment not found");
        const isParticipant =
            appointment.userId === actor.id || (actor.role === "doctor" && appointment.doctor.userId === actor.id);
        if (!isParticipant) throw forbidden("not a participant");

        return await prisma.followUp.findUnique({ where: { appointmentId } });
    }

    static async respond(followUpId: number, patientId: number, accept: boolean) {
        const followUp = await prisma.followUp.findUnique({
            where: { id: followUpId },
            include: { appointment: { select: { userId: true } } },
        });
        if (!followUp) throw notFound("Follow-up not found");
        if (followUp.appointment.userId !== patientId) {
            throw forbidden("not your appointment");
        }
        if (followUp.status !== "pending") throw conflict("This follow-up was already responded to");

        if (!accept) {
            const updated = await prisma.followUp.update({
                where: { id: followUpId },
                data: { status: "declined" },
            });
            return { followUp: updated, appointment: null };
        }

        const appointment = await prisma.appointment.findUnique({
            where: { id: followUp.appointmentId },
            include: { doctor: { select: { id: true, userId: true, awayUntil: true } } },
        });
        if (!appointment) throw notFound("Appointment not found");

        // A suggestion for a date that has already passed can no longer be
        // accepted — previously a doctor could propose a past date and the
        // patient could accept it into a confirmed session.
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const suggested = new Date(followUp.suggestedDate);
        if (isNaN(suggested.getTime())) throw badRequest("This follow-up has an invalid date");
        if (suggested < today) {
            throw conflict("This follow-up date has already passed — please ask your doctor for a new time");
        }

        // Times are compared in minutes, not lexicographically. The previous
        // check pushed the comparison into SQL where the columns are VARCHAR,
        // so `"10:00" <= "9:00"` was true and overlapping sessions were accepted.
        const start = timeToMinutes(followUp.startTime);
        const end = timeToMinutes(followUp.endTime);
        if (isNaN(start) || isNaN(end)) throw badRequest("This follow-up has an invalid time");
        if (start >= end) throw badRequest("This follow-up has an invalid time range");

        const dayStart = new Date(suggested);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const sameDay = await prisma.appointment.findMany({
            where: {
                doctorId: followUp.doctorId,
                appointmentDate: { gte: dayStart, lt: dayEnd },
                status: { in: ["pending", "confirmed"] },
            },
            select: { startTime: true, endTime: true },
        });
        const hasConflict = sameDay.some((a) =>
            overlaps(start, end, timeToMinutes(a.startTime ?? ""), timeToMinutes(a.endTime ?? ""))
        );
        if (hasConflict)
            throw conflict("That time is already booked for this doctor — please ask them for another slot");

        // Claim and create inside one transaction, and mark the follow-up
        // accepted in the same transaction. Previously the status was written
        // after the appointment, so a failure between the two left a
        // `pending` follow-up and a duplicate booking on retry.
        const created = await prisma.$transaction(async (tx) => {
            const claim = await tx.followUp.updateMany({
                where: { id: followUpId, status: "pending" },
                data: { status: "accepted" },
            });
            if (claim.count !== 1) throw conflict("This follow-up was already responded to");

            return tx.appointment.create({
                data: {
                    userId: patientId,
                    doctorId: followUp.doctorId,
                    appointmentDate: suggested,
                    startTime: followUp.startTime,
                    endTime: followUp.endTime,
                    consultationType: followUp.consultationType,
                    notes: followUp.notes || "Follow-up session",
                    status: "pending",
                    // A follow-up consumes a package session or referral credit
                    // like any other booking, so the ledger stays accurate.
                    ...(await this.findConsumableReservation(tx, patientId, followUp.doctorId)),
                },
            });
        });

        // Slot availability is cached on the doctor profile.
        const { invalidateDoctorCache } = await import("./doctor.service");
        invalidateDoctorCache(followUp.doctorId);

        await NotificationService.create({
            userId: appointment.doctor.userId,
            title: "Follow-up accepted",
            message: `Your patient accepted the follow-up on ${suggested.toLocaleDateString("en-GB")} at ${followUp.startTime}. Please confirm it.`,
            type: "appointment",
        });

        return { followUp: { ...followUp, status: "accepted" }, appointment: created };
    }

    /**
     * Follow-up bookings previously bypassed package/credit reservation
     * entirely, so the ledger drifted: sessions were consumed without being
     * decremented, and the credits a referral had granted were never spent.
     */
    private static async findConsumableReservation(
        tx: Prisma.TransactionClient,
        patientId: number,
        doctorId: number
    ): Promise<{ packagePurchaseId?: number; creditApplied?: boolean }> {
        const purchase = await tx.packagePurchase.findFirst({
            where: {
                userId: patientId,
                sessionsLeft: { gt: 0 },
                status: "active",
                // A package covers its own doctor's sessions.
                package: { doctorId },
            },
            orderBy: { createdAt: "asc" },
            select: { id: true },
        });
        if (purchase) {
            await tx.packagePurchase.update({
                where: { id: purchase.id },
                data: { sessionsLeft: { decrement: 1 }, status: "active" },
            });
            return { packagePurchaseId: purchase.id };
        }

        const user = await tx.user.findUnique({
            where: { id: patientId },
            select: { sessionCredits: true },
        });
        if (user && user.sessionCredits > 0) {
            await tx.user.update({
                where: { id: patientId },
                data: { sessionCredits: { decrement: 1 } },
            });
            return { creditApplied: true };
        }

        return {};
    }
}
