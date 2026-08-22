import { prisma } from "../lib/prisma";
import { NotificationService } from "./notification.service";

export class WaitlistService {
    static async join(doctorId: number, patientId: number) {
        const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
        if (!doctor) throw new Error("Doctor not found");

        const existing = await prisma.waitlistEntry.findFirst({
            where: { doctorId, patientId, status: "waiting" },
        });
        if (existing) throw new Error("You are already on this waitlist");

        const entry = await prisma.waitlistEntry.create({
            data: { doctorId, patientId, status: "waiting" },
        });
        return entry;
    }

    static async leave(doctorId: number, patientId: number) {
        await prisma.waitlistEntry.updateMany({
            where: { doctorId, patientId, status: "waiting" },
            data: { status: "expired" },
        });
        return { success: true };
    }

    static async status(doctorId: number, patientId: number) {
        const entry = await prisma.waitlistEntry.findFirst({
            where: { doctorId, patientId, status: { in: ["waiting", "notified"] } },
        });
        return entry ? { onWaitlist: true, status: entry.status, joinedAt: entry.createdAt } : { onWaitlist: false };
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
            const claim = await prisma.waitlistEntry.updateMany({
                where: { id: waiter.id, status: "waiting" },
                data: { status: "notified" },
            });
            if (claim.count !== 1) continue;

            await NotificationService.create({
                userId: waiter.patientId,
                title: "A slot just opened",
                message: "One of your waitlisted psychologists just opened a new slot. Book it before it's gone!",
                type: "appointment",
                email: true,
            });
            notified.push(waiter.patientId);
        }
        return notified;
    }

    /**
     * Waitlist hygiene (daily cron):
     * 1. Expire stale notifications — patients notified more than 48h ago
     *    who never booked re-enter the queue so the waitlist keeps moving.
     * 2. Drop very old waiting entries (> 90 days).
     */
    static async runWaitlistMaintenance() {
        const now = new Date();
        const notifyStaleCutoff = new Date(now.getTime() - 48 * 3600 * 1000);
        const waitingStaleCutoff = new Date(now.getTime() - 90 * 24 * 3600 * 1000);

        // Re-queue stale "notified" entries back to "waiting" (unique key
        // @@unique([doctorId, patientId, status]) allows only one row per
        // state, so delete the old row and recreate it as waiting)
        const staleNotified = await prisma.waitlistEntry.findMany({
            where: { status: "notified", createdAt: { lt: notifyStaleCutoff } },
            select: { id: true, doctorId: true, patientId: true },
            take: 200,
        });
        for (const entry of staleNotified) {
            try {
                await prisma.$transaction([
                    prisma.waitlistEntry.delete({ where: { id: entry.id } }),
                    prisma.waitlistEntry.create({
                        data: { doctorId: entry.doctorId, patientId: entry.patientId, status: "waiting" },
                    }),
                ]);
            } catch {
                // concurrent modification — skip
            }
        }

        const removed = await prisma.waitlistEntry.deleteMany({
            where: { status: "waiting", createdAt: { lt: waitingStaleCutoff } },
        });

        return { requeued: staleNotified.length, expiredWaiting: removed.count };
    }
}
