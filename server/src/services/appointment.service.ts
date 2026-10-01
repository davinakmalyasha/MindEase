import { prisma } from "../lib/prisma";
import { sanitize } from "../utils/sanitize";
import {
    parseLocalDate,
    localDateKey,
    timeToMinutes,
    overlaps,
    startOfZonedDay,
    resolveTimezone,
} from "../lib/date";
import crypto from "crypto";
import { MailerService } from "./mailer.service";
import { publishEvent } from "./realtime.service";
import { WaitlistService } from "./waitlist.service";
import { NotificationService } from "./notification.service";
import { activeProvider, buildGrant } from "./video.service";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../utils/appError";

const formatDate = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });



const generateMeetingLink = (appointmentId: number) =>
    // `crypto`, not `Math.random`: this string is the only thing standing between
    // a leaked link and an uninvited third party joining a therapy session.
    `https://meet.jit.si/MindEase-${appointmentId}-${crypto.randomBytes(8).toString("hex")}`;

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
        // returned to its owner — never leak another user's appointment.
        if (data.idempotencyKey) {
            const existing = await prisma.appointment.findUnique({
                where: { idempotencyKey: data.idempotencyKey },
            });
            if (existing) {
                if (existing.userId !== data.userId) throw conflict("This idempotency key is already in use");
                return existing;
            }
        }

        const doctor = await prisma.doctor.findUnique({
            where: { id: data.doctorId },
            include: { user: { select: { id: true } } },
        });
        if (!doctor) throw notFound("Doctor not found");
        if (doctor.verificationStatus !== "approved") {
            throw badRequest("This doctor is not accepting bookings yet");
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
                throw badRequest("Package session is not available");
            }
            if (purchase.package.doctorId !== data.doctorId) {
                throw badRequest("This package belongs to a different doctor");
            }
            packageReservationId = purchase.id;
        }

        const date = parseLocalDate(data.appointmentDate);
        if (isNaN(date.getTime())) throw badRequest("Invalid appointment date");

        // Away mode: sessions starting inside an away window are not bookable
        if (doctor.awayUntil) {
            const awayEnd = new Date(doctor.awayUntil);
            awayEnd.setHours(23, 59, 59, 999);
            if (date <= awayEnd) {
                throw badRequest("This doctor is currently away and not accepting bookings");
            }
        }

        const start = timeToMinutes(data.startTime);
        const end = timeToMinutes(data.endTime);
        if (isNaN(start) || isNaN(end) || start >= end) {
            throw badRequest("Invalid appointment time");
        }

        // Block booking in the past.
        //
        // The slot's calendar day and its `HH:mm` are both wall-clock readings
        // in the *booker's* timezone — that is how the availability UI presents
        // them. Reconstructing the instant with `new Date(date)` anchored the
        // day to the server's zone, so on a UTC host every WIB user's "today at
        // 23:00" was off by seven hours and legitimately bookable times were
        // rejected as past.
        const timezone = await this.getUserTimezone(data.userId);
        const zonedDayStart = startOfZonedDay(localDateKey(date), timezone);
        const slotStart = new Date(zonedDayStart.getTime() + start * 60 * 1000);
        if (slotStart.getTime() < Date.now() - 60_000) {
            throw badRequest("Cannot book appointments in the past");
        }

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
            if (reserved.count === 0) throw badRequest("Package session is not available");
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
        // Idempotent by construction. Every exit path after a reservation has
        // already run must be able to call this without risking a double refund,
        // so the single try/catch below owns every failure and the individual
        // paths no longer unwind piecemeal.
        let refunded = false;
        const refundReservations = async () => {
            if (refunded) return;
            refunded = true;
            await Promise.all([
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
        };

        const releaseSlot = async () => {
            if (slotId) {
                await prisma.consultationSlot
                    .updateMany({ where: { id: slotId }, data: { isBooked: false } })
                    .catch(() => {});
            }
        };

        let appointment;
        try {
            if (data.slotId) {
                const slot = await prisma.consultationSlot.findFirst({
                    where: { id: data.slotId, doctorId: data.doctorId },
                });
                if (!slot) throw notFound("Slot not found for this doctor");

                if (localDateKey(slot.date) !== localDateKey(date)) {
                    throw badRequest("Slot date does not match appointment date");
                }

                // Atomic claim: updateMany only succeeds when the slot is still
                // free, so two concurrent bookings cannot both win the race.
                const claimed = await prisma.consultationSlot.updateMany({
                    where: { id: slot.id, isBooked: false },
                    data: { isBooked: true },
                });
                if (claimed.count === 0) throw conflict("Slot is already booked");
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
            const hasConflict = sameDay.some((a) =>
                overlaps(start, end, timeToMinutes(a.startTime ?? ""), timeToMinutes(a.endTime ?? ""))
            );
            if (hasConflict) {
                throw conflict("This time is already booked for that doctor");
            }

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
            // Never strand a claimed slot or a paid reservation. Previously the
            // three throws in the slot block — unknown slot, date mismatch, and
            // already booked — escaped without refunding, so a patient with a
            // one-session package who double-clicked an occupied slot silently
            // lost the session they had paid for.
            await releaseSlot();
            await refundReservations();
            throw err;
        }

        // The reservation is now carried by a real appointment row. If the
        // process dies before this point the reservation is still lost, so the
        // refund is the *only* compensation path and it must be reachable from
        // every failure — which the single catch above now guarantees.
        refunded = true;

        // Settle any waitlist entry this booking fulfils. Without this the entry
        // stayed in `waiting`, so the daily maintenance job re-queued it and the
        // patient was notified about another opening for a slot they had already
        // taken — the `markBooked` method existed for this and was never called.
        await WaitlistService.markBooked(data.doctorId, data.userId).catch(() => {});

        this.sendBookingReceivedEmail(appointment, doctor, data.userId);

        // The doctor profile caches open slots; invalidate so the newly claimed
        // slot stops being offered to other patients.
        const { invalidateDoctorCache } = await import("./doctor.service");
        invalidateDoctorCache(appointment.doctorId);

        return appointment;
    }

    /**
     * The booker's calendar zone. `User.timezone` existed but was never read;
     * every day boundary in this service was implicitly the server's own zone.
     */
    private static async getUserTimezone(userId: number): Promise<string> {
        const user = await prisma.user
            .findUnique({ where: { id: userId }, select: { timezone: true } })
            .catch(() => null);
        return resolveTimezone(user?.timezone);
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
            if (!doctor) throw notFound("Doctor profile not found");
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
        if (!appointment) throw notFound("Appointment not found");

        const ALLOWED = ["confirmed", "cancelled", "completed"];
        if (!ALLOWED.includes(status)) throw badRequest("Invalid status");

        // Terminal states are immutable — no cancelling/completing a session
        // that already finished, and no resurrecting cancelled ones.
        if (["cancelled", "completed"].includes(appointment.status)) {
                throw conflict(`Cannot change an appointment that is already ${appointment.status}`);
        }

        if (actor.role === "doctor") {
            const doctor = await prisma.doctor.findUnique({ where: { userId: actor.id } });
            if (!doctor || doctor.id !== appointment.doctorId) {
                throw forbidden("not your appointment");
            }
            if (appointment.status === "pending" && status === "completed") {
                throw badRequest("Cannot complete a pending appointment");
            }
        } else if (actor.role === "patient") {
            if (appointment.userId !== actor.id) {
                throw forbidden("not your appointment");
            }
            if (status !== "cancelled") {
                throw badRequest("Patients can only cancel appointments");
            }
            if (appointment.status === "confirmed") {
                // Grace window: a confirmed session stays cancellable by the
                // patient until 24 hours before it starts.
                const start = new Date(appointment.appointmentDate);
                const [h, m] = (appointment.startTime || "00:00").split(":").map(Number);
                start.setHours(h || 0, m || 0, 0, 0);
                if (start.getTime() - Date.now() < 24 * 60 * 60 * 1000) {
                    throw badRequest(
                        "This session starts in less than 24 hours — please contact your doctor to reschedule or cancel"
                    );
                }
            } else if (appointment.status !== "pending") {
                throw badRequest("Only pending appointments can be cancelled by the patient");
            }
        } else if (actor.role === "admin") {
            if (status === "completed") throw badRequest("Admins cannot complete appointments");
        } else {
            throw unauthorized("role");
        }

        const updated = await prisma.appointment.update({
            where: { id },
            data: { status },
        });

        // A confirmed live appointment needs a stable room identity before either
        // party joins, so the seed is created here. It is provider-agnostic: the
        // livekit room name is derived from it, and the jitsi URL is not used at
        // all when livekit is configured.
        if (status === "confirmed" && !updated.roomSeed && ["video", "voice"].includes(updated.consultationType)) {
            const roomSeed = crypto.randomBytes(8).toString("hex");
            await prisma.appointment.update({ where: { id }, data: { roomSeed } });
            updated.roomSeed = roomSeed;

            // Only mint the persistent URL on the degraded jitsi path. On livekit
            // there is no URL: a stored, unauthenticated room link is exactly the
            // artefact this migration removes, and pre-creating one would leave
            // it in the database, the .ics export and the GDPR data export.
            if (activeProvider().provider === "jitsi" && !updated.meetingLink) {
                const link = generateMeetingLink(id);
                await prisma.appointment.update({ where: { id }, data: { meetingLink: link } });
                updated.meetingLink = link;
            }
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

        // Release the slot when cancelled.
        //
        // The slot link must be cleared, not just the `isBooked` flag:
        // `Appointment.slotId` is unique, so leaving it attached would make the
        // freed slot permanently unbookable — every future attempt to book it
        // would collide with this cancelled row. That also silently broke the
        // waitlist, which emails patients to book a slot nobody could reserve.
        if (status === "cancelled" && updated.slotId) {
            await prisma.consultationSlot
                .updateMany({
                    where: { id: updated.slotId },
                    data: { isBooked: false },
                })
                .catch(() => null);
            await prisma.appointment
                .update({ where: { id }, data: { slotId: null } })
                .catch(() => null);
            updated.slotId = null;
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
        if (!appointment) throw notFound("Appointment not found");
        if (appointment.userId !== actor.id) throw forbidden("not your appointment");
        if (appointment.status !== "confirmed" && appointment.status !== "pending") {
            throw badRequest("Only pending or confirmed appointments can be rescheduled");
        }

        const date = parseLocalDate(data.appointmentDate);
        if (isNaN(date.getTime())) throw badRequest("Invalid date");
        const start = timeToMinutes(data.startTime);
        const end = timeToMinutes(data.endTime);
        if (isNaN(start) || isNaN(end) || start >= end) throw badRequest("Invalid time");

        // Block rescheduling into the past
        const now = new Date();
        const newStart = new Date(date);
        newStart.setHours(0, 0, 0, 0);
        newStart.setMinutes(start);
        if (newStart < now) throw badRequest("Cannot reschedule into the past");

        // `slotId` is the slot the appointment will end up pointing at, which
        // may be the slot it already holds. `claimedSlotId` is the subset this
        // request actually took a lock on. Compensation must only ever release
        // `claimedSlotId`: releasing an unclaimed slot would advertise a booking
        // as free while the appointment still references it, and the next
        // patient to take it double-books the clinician.
        let slotId: number | undefined;
        let claimedSlotId: number | undefined;
        if (data.slotId) {
            const slot = await prisma.consultationSlot.findFirst({
                where: { id: data.slotId, doctorId: appointment.doctorId },
            });
            if (!slot) throw notFound("Slot not found for this doctor");
            if (localDateKey(slot.date) !== localDateKey(date)) {
                throw badRequest("Slot date does not match appointment date");
            }
            // Keeping the current slot needs no claim; claiming a new one must
            // happen BEFORE releasing the old so a failed claim never loses
            // the original booking's slot.
            if (slot.id !== appointment.slotId) {
                const claimed = await prisma.consultationSlot.updateMany({
                    where: { id: slot.id, isBooked: false },
                    data: { isBooked: true },
                });
                if (claimed.count === 0) throw conflict("Slot is already booked");
                claimedSlotId = slot.id;
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
        const hasConflict = sameDay.some((a) =>
            overlaps(start, end, timeToMinutes(a.startTime ?? ""), timeToMinutes(a.endTime ?? ""))
        );
        if (hasConflict) {
            if (claimedSlotId) {
                await prisma.consultationSlot
                    .updateMany({ where: { id: claimedSlotId }, data: { isBooked: false } })
                    .catch(() => {});
            }
            throw conflict("This time is already booked for that doctor");
        }

        try {
            // The pre-session disclosure and the AI briefing derived from it
            // describe the *previous* appointment, so the doctor must not read a
            // briefing built for a date that no longer applies.
            //
            // A nested `preSessionData: { delete: true }` throws when no row
            // exists, which is the common case, so it is an explicit
            // `deleteMany` in the same transaction as the update instead.
            const updated = await prisma.$transaction(async (tx) => {
                await tx.preSessionData.deleteMany({ where: { appointmentId: id } });

                return tx.appointment.update({
                    where: { id },
                    data: {
                        appointmentDate: date,
                        startTime: data.startTime,
                        endTime: data.endTime,
                        slotId: slotId ?? null,
                        status: "pending",
                        meetingLink: null,
                        // A new slot is a new session, so it must not inherit the
                        // previous room. Leaving the old seed would let anyone
                        // holding a token from before the reschedule still reach
                        // the room for the new time.
                        roomSeed: null,
                        // The reminder and check-in claims are keyed on the old
                        // date. Without clearing them the rescheduled session
                        // would never be reminded about its new time.
                        reminderSentAt: null,
                        checkinSentAt: null,
                    },
                });
            });

            // Release the previous slot only after the move succeeded
            if (appointment.slotId && appointment.slotId !== slotId) {
                await prisma.consultationSlot.updateMany({
                    where: { id: appointment.slotId },
                    data: { isBooked: false },
                });
            }

            // Slot availability is cached on the doctor profile; without this a
            // patient could still be offered a slot that was just taken.
            const { invalidateDoctorCache } = await import("./doctor.service");
            invalidateDoctorCache(updated.doctorId);

            return updated;
        } catch (err) {
            // Only undo a claim this request made. See the `claimedSlotId` note
            // above: a reschedule that keeps the current slot must not release
            // it on the way out.
            if (claimedSlotId) {
                await prisma.consultationSlot
                    .updateMany({ where: { id: claimedSlotId }, data: { isBooked: false } })
                    .catch(() => {});
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
        if (!appointment) throw notFound("Appointment not found");
        if (appointment.status !== "confirmed") throw badRequest("This consultation is not active");
        if (!["video", "voice"].includes(appointment.consultationType)) {
            throw badRequest("This consultation has no live room (text chat only)");
        }

        const isPatient = appointment.userId === actor.id;
        const isDoctor = appointment.doctor.userId === actor.id;
        if (!isPatient && !isDoctor) {
            throw forbidden("not a participant of this consultation");
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
            throw badRequest(`The room opens in ${minutesUntilOpen} minutes`);
        }
        if (now > end.getTime() + CLOSE_LATE_MS) {
            throw badRequest("This consultation room has closed");
        }

        // `meetingLink` is no longer generated here. A persistent, guessable-
        // only-by-luck URL was the unauthenticated artefact the video migration
        // removes; on the livekit path there is no URL at all, only a short-lived
        // scoped token. The column is kept and still populated on the jitsi
        // fallback path for clients that have not been updated.

        const counterpartId = isPatient ? appointment.doctor.userId : appointment.userId;
        await publishEvent(counterpartId, {
            type: "appointment:join",
            payload: {
                appointmentId: id,
                name: actor.name || "Your counterpart",
                consultationType: appointment.consultationType,
            },
        });

        // The room seed is generated once and persisted, because the two
        // participants arrive at this method independently and must land in the
        // same room. Deriving it per request would put each of them somewhere
        // different, which presents as "the other person never joined".
        let roomSeed = appointment.roomSeed;
        if (!roomSeed) {
            roomSeed = crypto.randomBytes(8).toString("hex");
            await prisma.appointment.update({ where: { id }, data: { roomSeed } });
        }

        // The token is scoped to the end of the window, not to a constant, so a
        // token captured from a proxy log is useless once the session is over.
        const providerState = activeProvider();
        const grant = buildGrant({
            appointmentId: id,
            userId: actor.id,
            displayName: actor.name || "Participant",
            roomSeed,
            validUntilMs: end.getTime() + CLOSE_LATE_MS,
        });

        return {
            // `provider`, `room` and `token` are the new contract. `meetingLink`
            // is still returned for the jitsi path and for any client that has
            // not been updated; it is `null` on livekit, where a persistent URL
            // would be the unauthenticated artefact this change exists to
            // remove.
            provider: grant.provider,
            room: grant.room,
            token: grant.token ?? null,
            identity: grant.identity,
            meetingLink: grant.provider === "jitsi" ? grant.room : null,
            // The server states whether this consultation is authenticated,
            // rather than the client inferring it from the provider name. The
            // privacy policy and ARCHITECTURE.md both promise the patient is
            // told, and a disclosure whose truth is computed in the browser is
            // a disclosure that can be wrong. `degradedReason` is set only when
            // an operator asked for livekit and the deployment could not supply
            // it, which is the case a patient actually needs explained.
            degraded: providerState.degraded,
            degradedReason: providerState.degraded ? providerState.reason ?? null : null,
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
        if (!appointment) throw notFound("Appointment not found");

        const isPatient = appointment.userId === actor.id;
        const isDoctor = actor.role === "doctor" && appointment.doctor.userId === actor.id;
        if (!isPatient && !isDoctor) throw forbidden("not a participant");

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
