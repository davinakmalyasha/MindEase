import { prisma } from "../lib/prisma";
import { sanitize } from "../utils/sanitize";
import { parseLocalDate, localDateKey } from "../utils/date";
import { MailerService } from "./mailer.service";
import { publishEvent } from "./realtime.service";
import { WaitlistService } from "./waitlist.service";
import { NotificationService } from "./notification.service";

const formatDate = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });



const timeToMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    if (isNaN(h) || isNaN(m)) return NaN;
    return h * 60 + m;
};

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
        packagePurchaseId?: number;
    }) {
        // Idempotency: replay-safe bookings. The stored result may only be
        // returned to its owner â€” never leak another user's appointment.
        if (data.idempotencyKey) {
            const existing = await prisma.appointment.findUnique({
                where: { idempotencyKey: data.idempotencyKey },
            });
            if (existing) {
                if (existing.userId !== data.userId) throw new Error("This idempotency key is already in use");
                return existing;
            }
        }

        const doctor = await prisma.doctor.findUnique({
            where: { id: data.doctorId },
            include: { user: { select: { id: true } } },
        });
        if (!doctor) throw new Error("Doctor not found");
        if (doctor.verificationStatus !== "approved") {
            throw new Error("This doctor is not accepting bookings yet");
        }

        // Package session: verify ownership, active status, and doctor match.
        // The session itself is RESERVED atomically right before booking
        // (prevents unlimited future bookings against one package) and
        // refunded on cancellation or any downstream failure.
        let packagePurchaseId: number | undefined;
        let packageReservationId: number | undefined;
        if (data.packagePurchaseId) {
            const purchase = await prisma.packagePurchase.findUnique({
                where: { id: data.packagePurchaseId },
                include: { package: { select: { doctorId: true } } },
            });
            if (!purchase || purchase.userId !== data.userId || purchase.status !== "active" || purchase.sessionsLeft < 1) {
                throw new Error("Package session is not available");
            }
            if (purchase.package.doctorId !== data.doctorId) {
                throw new Error("This package belongs to a different doctor");
            }
            packageReservationId = purchase.id;
        }

        const date = parseLocalDate(data.appointmentDate);
        if (isNaN(date.getTime())) throw new Error("Invalid appointment date");

        // Away mode: sessions starting inside an away window are not bookable
        if (doctor.awayUntil) {
            const awayEnd = new Date(doctor.awayUntil);
            awayEnd.setHours(23, 59, 59, 999);
            if (date <= awayEnd) {
                throw new Error("This doctor is currently away and not accepting bookings");
            }
        }

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

        // Reserve paid-for capacity atomically BEFORE touching slots:
        // - package session (decrement now, restore on cancel/failure)
        // - referral session credit (auto-applied when the patient has one)
        let creditApplied = false;
        if (packageReservationId) {
            const reserved = await prisma.packagePurchase.updateMany({
                where: { id: packageReservationId, status: "active", sessionsLeft: { gte: 1 } },
                data: { sessionsLeft: { decrement: 1 } },
            });
            if (reserved.count === 0) throw new Error("Package session is not available");
            // Exhausted packages flip to completed immediately
            await prisma.packagePurchase
                .updateMany({ where: { id: packageReservationId, sessionsLeft: 0 }, data: { status: "completed" } })
                .catch(() => {});
            packagePurchaseId = packageReservationId;
        } else if ((doctor.price || 0) > 0) {
            const claimed = await prisma.user.updateMany({
                where: { id: data.userId, sessionCredits: { gt: 0 } },
                data: { sessionCredits: { decrement: 1 } },
            });
            creditApplied = claimed.count === 1;
        }
        const refundReservations = () =>
            Promise.all([
                packagePurchaseId
                    ? prisma.packagePurchase
                          .update({
                              where: { id: packagePurchaseId },
                              data: { sessionsLeft: { increment: 1 }, status: "active" },
                          })
                          .catch(() => {})
                    : Promise.resolve(),
                creditApplied
                    ? prisma.user
                          .update({ where: { id: data.userId }, data: { sessionCredits: { increment: 1 } } })
                          .catch(() => {})
                    : Promise.resolve(),
            ]);

        if (data.slotId) {
            const slot = await prisma.consultationSlot.findFirst({
                where: { id: data.slotId, doctorId: data.doctorId },
            });
            if (!slot) throw new Error("Slot not found for this doctor");

            if (localDateKey(slot.date) !== localDateKey(date)) {
                throw new Error("Slot date does not match appointment date");
            }

            // Atomic claim: updateMany only succeeds when the slot is still
            // free, so two concurrent bookings cannot both win the race.
            const claimed = await prisma.consultationSlot.updateMany({
                where: { id: slot.id, isBooked: false },
                data: { isBooked: true },
            });
            if (claimed.count === 0) throw new Error("Slot is already booked");
            slotId = slot.id;
        }

        // Detect double-booking for the same doctor at the same time.
        // Times are compared numerically so unpadded strings ("9:00")
        // cannot slip through lexicographic comparison.
        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const sameDay = await prisma.appointment.findMany({
            where: {
                doctorId: data.doctorId,
                appointmentDate: { gte: dayStart, lt: dayEnd },
                status: { in: ["pending", "confirmed"] },
            },
            select: { startTime: true, endTime: true },
        });
        const hasConflict = sameDay.some((a) => {
            const s = timeToMinutes(a.startTime ?? "");
            const e = timeToMinutes(a.endTime ?? "");
            return !isNaN(s) && !isNaN(e) && start < e && s < end;
        });
        if (hasConflict) {
            if (slotId) {
                await prisma.consultationSlot.updateMany({ where: { id: slotId }, data: { isBooked: false } }).catch(() => {});
            }
            await refundReservations();
            throw new Error("This time is already booked for that doctor");
        }

        let appointment;
        try {
            appointment = await prisma.appointment.create({
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
                    creditApplied,
                    ...(packagePurchaseId ? { packagePurchaseId } : {}),
                },
            });
        } catch (err) {
            // Never strand a claimed slot or reservation when the create fails
            if (slotId) {
                await prisma.consultationSlot.updateMany({ where: { id: slotId }, data: { isBooked: false } }).catch(() => {});
            }
            await refundReservations();
            throw err;
        }

        this.sendBookingReceivedEmail(appointment, doctor, data.userId);

        return appointment;
    }

    private static async sendBookingReceivedEmail(
        appointment: { appointmentDate: Date; startTime: string | null; consultationType: string; notes: string | null },
        doctor: { userId: number },
        patientUserId: number
    ) {
        try {
            const [doctorUser, patientUser] = await Promise.all([
                prisma.user.findUnique({ where: { id: doctor.userId }, select: { name: true, email: true } }),
                prisma.user.findUnique({ where: { id: patientUserId }, select: { name: true } }),
            ]);
            if (!doctorUser?.email) return;
            const { subject, html } = MailerService.buildBookingReceivedEmail({
                doctorName: doctorUser.name || "Doctor",
                patientName: patientUser?.name || "A patient",
                date: formatDate(appointment.appointmentDate),
                time: appointment.startTime || "",
                type: appointment.consultationType,
                notes: appointment.notes,
            });
            await MailerService.send(doctorUser.email, subject, html);
        } catch (err: any) {
            console.error("[Email] booking received email failed:", err.message);
        }
    }

    private static async sendBookingConfirmedEmail(appointment: any) {
        try {
            const [patient, doctor] = await Promise.all([
                prisma.user.findUnique({ where: { id: appointment.userId }, select: { name: true, email: true } }),
                prisma.doctor.findUnique({
                    where: { id: appointment.doctorId },
                    include: { user: { select: { name: true } } },
                }),
            ]);
            if (!patient?.email) return;
            const { subject, html } = MailerService.buildBookingConfirmedEmail({
                patientName: patient.name || "there",
                doctorName: doctor?.user?.name || "your doctor",
                date: formatDate(appointment.appointmentDate),
                time: appointment.startTime || "",
                type: appointment.consultationType,
            });
            await MailerService.send(patient.email, subject, html);
        } catch (err: any) {
            console.error("[Email] booking confirmed email failed:", err.message);
        }
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
                followUp: true,
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
                        followUp: true,
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
                        followUp: true,
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
                    followUp: true,
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

        // Terminal states are immutable â€” no cancelling/completing a session
        // that already finished, and no resurrecting cancelled ones.
        if (["cancelled", "completed"].includes(appointment.status)) {
            throw new Error(`Cannot change an appointment that is already ${appointment.status}`);
        }

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
            if (appointment.status === "confirmed") {
                // Grace window: a confirmed session stays cancellable by the
                // patient until 24 hours before it starts.
                const start = new Date(appointment.appointmentDate);
                const [h, m] = (appointment.startTime || "00:00").split(":").map(Number);
                start.setHours(h || 0, m || 0, 0, 0);
                if (start.getTime() - Date.now() < 24 * 60 * 60 * 1000) {
                    throw new Error(
                        "This session starts in less than 24 hours — please contact your doctor to reschedule or cancel"
                    );
                }
            } else if (appointment.status !== "pending") {
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

        // Attach a meeting link when confirmed (video and voice calls both use a Jitsi room)
        if (status === "confirmed" && !updated.meetingLink && ["video", "voice"].includes(updated.consultationType)) {
            const link = generateMeetingLink(id);
            await prisma.appointment.update({ where: { id }, data: { meetingLink: link } });
            updated.meetingLink = link;
        }

        // Audit every lifecycle transition (who changed what, from which state)
        const { AuditService } = await import("./audit.service");
        await AuditService.log({
            action: `appointment.${status}`,
            actorId: actor.id,
            targetType: "Appointment",
            targetId: id,
            meta: { from: appointment.status, to: status, role: actor.role },
        }).catch(() => {});

        // Notify the patient by email when their session is confirmed
        if (status === "confirmed") {
            this.sendBookingConfirmedEmail(updated);
        }

        // Release the slot when cancelled
        if (status === "cancelled" && updated.slotId) {
            await prisma.consultationSlot.update({
                where: { id: updated.slotId },
                data: { isBooked: false },
            });
            // Waitlisted patients get notified about the freed slot
            await WaitlistService.notifyWaiters(updated.doctorId).catch(() => {});
        }

        // Refund a referral credit or package session used for a cancelled booking
        if (status === "cancelled" && (updated.creditApplied || updated.packagePurchaseId)) {
            await Promise.all([
                updated.creditApplied
                    ? prisma.user
                          .update({ where: { id: updated.userId }, data: { sessionCredits: { increment: 1 } } })
                          .catch(() => {})
                    : Promise.resolve(),
                updated.packagePurchaseId
                    ? prisma.packagePurchase
                          .update({
                              where: { id: updated.packagePurchaseId },
                              data: { sessionsLeft: { increment: 1 }, status: "active" },
                          })
                          .catch(() => {})
                    : Promise.resolve(),
            ]);
        }

        // NOTE: package sessions are reserved at booking time (see
        // createAppointment), so completion no longer decrements anything.

        // Referral reward: the referrer earns one free-session credit when
        // their referred patient completes a first session
        if (status === "completed") {
            const referral = await prisma.referral.findFirst({
                where: { referredId: updated.userId, status: "pending" },
            });
            if (referral) {
                const completedCount = await prisma.appointment.count({
                    where: { userId: updated.userId, status: "completed" },
                });
                if (completedCount === 1) {
                    await prisma.$transaction([
                        prisma.referral.update({ where: { id: referral.id }, data: { status: "credited" } }),
                        prisma.user.update({ where: { id: referral.referrerId }, data: { sessionCredits: { increment: 1 } } }),
                    ]);
                    await NotificationService.create({
                        userId: referral.referrerId,
                        title: "Referral complete — you earned a free session 🎉",
                        message: "Thanks to your referral, a friend completed their first session. A session credit has been added to your account and will automatically cover your next booking.",
                        type: "system",
                        email: true,
                    });
                }
            }
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

        const date = parseLocalDate(data.appointmentDate);
        if (isNaN(date.getTime())) throw new Error("Invalid date");
        const start = timeToMinutes(data.startTime);
        const end = timeToMinutes(data.endTime);
        if (isNaN(start) || isNaN(end) || start >= end) throw new Error("Invalid time");

        // Block rescheduling into the past
        const now = new Date();
        const newStart = new Date(date);
        newStart.setHours(0, 0, 0, 0);
        newStart.setMinutes(start);
        if (newStart < now) throw new Error("Cannot reschedule into the past");

        let slotId: number | undefined;
        if (data.slotId) {
            const slot = await prisma.consultationSlot.findFirst({
                where: { id: data.slotId, doctorId: appointment.doctorId },
            });
            if (!slot) throw new Error("Slot not found for this doctor");
            if (localDateKey(slot.date) !== localDateKey(date)) {
                throw new Error("Slot date does not match appointment date");
            }
            // Keeping the current slot needs no claim; claiming a new one must
            // happen BEFORE releasing the old so a failed claim never loses
            // the original booking's slot.
            if (slot.id !== appointment.slotId) {
                const claimed = await prisma.consultationSlot.updateMany({
                    where: { id: slot.id, isBooked: false },
                    data: { isBooked: true },
                });
                if (claimed.count === 0) throw new Error("Slot is already booked");
            }
            slotId = slot.id;
        }

        // Conflict check against the doctor's other active bookings
        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        const sameDay = await prisma.appointment.findMany({
            where: {
                doctorId: appointment.doctorId,
                id: { not: id },
                appointmentDate: { gte: dayStart, lt: dayEnd },
                status: { in: ["pending", "confirmed"] },
            },
            select: { startTime: true, endTime: true },
        });
        const hasConflict = sameDay.some((a) => {
            const s = timeToMinutes(a.startTime ?? "");
            const e = timeToMinutes(a.endTime ?? "");
            return !isNaN(s) && !isNaN(e) && start < e && s < end;
        });
        if (hasConflict) {
            if (slotId) {
                await prisma.consultationSlot.updateMany({ where: { id: slotId }, data: { isBooked: false } }).catch(() => {});
            }
            throw new Error("This time is already booked for that doctor");
        }

        try {
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

            // Release the previous slot only after the move succeeded
            if (appointment.slotId && appointment.slotId !== slotId) {
                await prisma.consultationSlot.updateMany({
                    where: { id: appointment.slotId },
                    data: { isBooked: false },
                });
            }

            return updated;
        } catch (err) {
            if (slotId) {
                await prisma.consultationSlot.updateMany({ where: { id: slotId }, data: { isBooked: false } }).catch(() => {});
            }
            throw err;
        }
    }

    /**
     * Joins a confirmed consultation room. Only the two participants may join;
     * the room is available from 15 minutes before the start until 1 hour after.
     * Publishes a realtime event so the counterpart gets pinged.
     */
    static async joinRoom(id: number, actor: { id: number; name?: string | null }) {
        const appointment = await prisma.appointment.findUnique({
            where: { id },
            include: {
                user: { select: { id: true, name: true } },
                doctor: { include: { user: { select: { id: true, name: true } } } },
            },
        });
        if (!appointment) throw new Error("Appointment not found");
        if (appointment.status !== "confirmed") throw new Error("This consultation is not active");
        if (!["video", "voice"].includes(appointment.consultationType)) {
            throw new Error("This consultation has no live room (text chat only)");
        }

        const isPatient = appointment.userId === actor.id;
        const isDoctor = appointment.doctor.userId === actor.id;
        if (!isPatient && !isDoctor) {
            throw new Error("Forbidden: not a participant of this consultation");
        }

        const start = new Date(appointment.appointmentDate);
        const [h, m] = (appointment.startTime || "00:00").split(":").map(Number);
        start.setHours(h || 0, m || 0, 0, 0);

        const now = Date.now();
        const OPEN_EARLY_MS = 15 * 60 * 1000;
        const closeMs = (appointment.endTime || "00:00").split(":").map(Number);
        const end = new Date(appointment.appointmentDate);
        end.setHours(closeMs[0] || 0, closeMs[1] || 0, 0, 0);
        const CLOSE_LATE_MS = 60 * 60 * 1000;

        if (now < start.getTime() - OPEN_EARLY_MS) {
            const minutesUntilOpen = Math.ceil((start.getTime() - OPEN_EARLY_MS - now) / 60000);
            throw new Error(`The room opens in ${minutesUntilOpen} minutes`);
        }
        if (now > end.getTime() + CLOSE_LATE_MS) {
            throw new Error("This consultation room has closed");
        }

        let meetingLink = appointment.meetingLink;
        if (!meetingLink) {
            meetingLink = generateMeetingLink(id);
            await prisma.appointment.update({ where: { id }, data: { meetingLink } });
        }

        const counterpartId = isPatient ? appointment.doctor.userId : appointment.userId;
        await publishEvent(counterpartId, {
            type: "appointment:join",
            payload: {
                appointmentId: id,
                name: actor.name || "Your counterpart",
                consultationType: appointment.consultationType,
            },
        });

        return {
            meetingLink,
            consultationType: appointment.consultationType,
            startTime: appointment.startTime,
            endTime: appointment.endTime,
            patient: appointment.user,
            doctor: appointment.doctor.user,
            openedAt: start.getTime() - OPEN_EARLY_MS,
        };
    }

    /**
     * Rebook assist: after a cancellation, offer the same doctor's next open
     * slots plus open slots from same-specialty doctors (within 14 days).
     */
    static async getRebookOptions(id: number, actor: { id: number; role: string }) {
        const appointment = await prisma.appointment.findUnique({
            where: { id },
            include: { doctor: { select: { id: true, specialty: true, userId: true } } },
        });
        if (!appointment) throw new Error("Appointment not found");

        const isPatient = appointment.userId === actor.id;
        const isDoctor = actor.role === "doctor" && appointment.doctor.userId === actor.id;
        if (!isPatient && !isDoctor) throw new Error("Forbidden: not a participant");

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const horizon = new Date(today);
        horizon.setDate(horizon.getDate() + 14);

        const slotWhere = {
            isBooked: false,
            date: { gte: today, lte: horizon },
        };

        const [sameDoctorSlots, similarDoctors] = await Promise.all([
            prisma.consultationSlot.findMany({
                where: { doctorId: appointment.doctorId, ...slotWhere },
                orderBy: [{ date: "asc" }, { startTime: "asc" }],
                take: 3,
            }),
            prisma.doctor.findMany({
                where: {
                    specialty: appointment.doctor.specialty,
                    id: { not: appointment.doctorId },
                    verificationStatus: "approved",
                },
                include: { user: { select: { id: true, name: true, avatar: true } } },
                take: 3,
            }),
        ]);

        const similarDoctorIds = similarDoctors.map((d) => d.id);
        const similarSlots = similarDoctorIds.length
            ? await prisma.consultationSlot.findMany({
                  where: { doctorId: { in: similarDoctorIds }, ...slotWhere },
                  include: {
                      doctor: {
                          include: { user: { select: { id: true, name: true, avatar: true } } },
                      },
                  },
                  orderBy: [{ date: "asc" }, { startTime: "asc" }],
                  take: 3,
              })
            : [];

        return {
            sameDoctor: {
                doctorId: appointment.doctorId,
                slots: sameDoctorSlots,
            },
            similarDoctors: similarSlots.map((s) => ({
                slot: { id: s.id, date: s.date, startTime: s.startTime, endTime: s.endTime },
                doctor: {
                    id: s.doctor.id,
                    userId: s.doctor.user.id,
                    name: s.doctor.user.name || "Doctor",
                    avatar: s.doctor.user.avatar,
                    specialty: s.doctor.specialty,
                    price: s.doctor.price,
                    rating: s.doctor.rating,
                },
            })),
        };
    }
}
