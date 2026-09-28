import { prisma } from "../lib/prisma";
import { NotificationService } from "./notification.service";

/** A waitlist row is stale once this long has passed without the patient booking. */
const NOTIFICATION_TTL_MS = 48 * 60 * 60 * 1000;
/** Very old unfulfilled waiting entries are dropped. */
const WAITING_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export class WaitlistService {
    static async join(doctorId: number, patientId: number) {
        const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
        if (!doctor) throw new Error("Doctor not found");

        const existing = await prisma.waitlistEntry.findUnique({
            where: { doctorId_patientId: { doctorId, patientId } },
        });
        if (existing && existing.status !== "expired" && existing.status !== "booked") {
            throw new Error("You are already on this waitlist");
        }

        // One row per (doctor, patient). The previous unique key included
        // `status`, so a patient who re-joined after being notified got a second
        // row and was notified twice about the same opening.
        const entry = await prisma.waitlistEntry.upsert({
            where: { doctorId_patientId: { doctorId, patientId } },
            create: { doctorId, patientId, status: "waiting" },
            update: { status: "waiting", notifiedAt: null },
        });
        return entry;
    }

    static async leave(doctorId: number, patientId: number) {
        await prisma.waitlistEntry.updateMany({
            where: { doctorId, patientId, status: { in: ["waiting", "notified"] } },
            data: { status: "expired" },
        });
        return { success: true };
    }

    static async status(doctorId: number, patientId: number) {
        const entry = await prisma.waitlistEntry.findFirst({
            where: { doctorId, patientId, status: { in: ["waiting", "notified"] } },
        });
        return entry
            ? { onWaitlist: true, status: entry.status, joinedAt: entry.createdAt }
            : { onWaitlist: false };
    }

    /** Marks the waitlist entry as fulfilled when the patient books. */
    static async markBooked(doctorId: number, patientId: number) {
        await prisma.waitlistEntry
            .updateMany({
                where: { doctorId, patientId, status: { in: ["waiting", "notified"] } },
                data: { status: "booked" },
            })
            .catch(() => null);
    }

    /**
     * Notifies waiting patients that a slot just opened (top N, claim-style so
     * multiple replicas never double-notify). Called on slot release / creation.
     */
    static async notifyWaiters(doctorId: number, limit = 3) {
        const waiters = await prisma.waitlistEntry.findMany({
            where: { doctorId, status: "waiting" },
            orderBy: { createdAt: "asc" },
            take: limit,
        });

        const notified: number[] = [];
        for (const waiter of waiters) {
            // Compare-and-swap on status, so only one replica wins per waiter.
            const claim = await prisma.waitlistEntry.updateMany({
                where: { id: waiter.id, status: "waiting" },
                data: { status: "notified", notifiedAt: new Date() },
            });
            if (claim.count !== 1) continue;

            await NotificationService.create({
                userId: waiter.patientId,
                title: "A slot just opened",
                message:
                    "One of your waitlisted psychologists just opened a new slot. Book it before it's gone!",
                type: "appointment",
                email: true,
            });
            notified.push(waiter.patientId);
        }
        return notified;
    }

    /**
     * Waitlist hygiene (daily cron):
     * 1. Re-queue patients notified more than 48h ago who never booked, so the
     *    waitlist keeps moving.
     * 2. Drop waiting entries older than 90 days.
     */
    static async runWaitlistMaintenance() {
        const now = Date.now();
        const staleNotifiedAt = new Date(now - NOTIFICATION_TTL_MS);
        const waitingStaleBefore = new Date(now - WAITING_TTL_MS);

        // A single bulk update — the previous implementation deleted and
        // recreated each row inside its own transaction, because the old unique
        // key made a status change impossible in place.
        //
        // `notifiedAt` is preferred, but rows written before the column existed
        // have it null, so `createdAt` is used as the fallback rather than
        // leaving those notifications stuck in `notified` forever.
        const requeued = await prisma.waitlistEntry.updateMany({
            where: {
                status: "notified",
                OR: [
                    { notifiedAt: { lt: staleNotifiedAt } },
                    { notifiedAt: null, createdAt: { lt: staleNotifiedAt } },
                ],
            },
            data: { status: "waiting", notifiedAt: null },
        });

        const removed = await prisma.waitlistEntry.deleteMany({
            where: { status: "waiting", createdAt: { lt: waitingStaleBefore } },
        });

        return { requeued: requeued.count, expiredWaiting: removed.count };
    }
}
