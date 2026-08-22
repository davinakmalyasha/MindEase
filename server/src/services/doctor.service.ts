import { prisma } from "../lib/prisma";
import { parseLocalDate, localDateKey } from "../utils/date";
import { cacheGet, cacheSet, cacheDel } from "../lib/cache";
import { WaitlistService } from "./waitlist.service";

const DIRECTORY_CACHE_KEY = "cache:doctors:directory";
const doctorDetailKey = (id: number) => `cache:doctors:detail:${id}`;

// Cache invalidation hooks — call after any doctor profile change.
export const invalidateDoctorCache = (doctorId?: number) =>
    cacheDel(DIRECTORY_CACHE_KEY, doctorId ? doctorDetailKey(doctorId) : "");



const timeToMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    if (isNaN(h) || isNaN(m)) return NaN;
    return h * 60 + m;
};

export type DoctorSort = "rating" | "price_asc" | "price_desc" | "experience";

const SORT_ORDERS: Record<DoctorSort, Record<string, string>> = {
    rating: { rating: "desc" },
    price_asc: { price: "asc" },
    price_desc: { price: "desc" },
    experience: { experience: "desc" },
};

export class DoctorService {
    static async getAllDoctors(
        page = 1,
        limit = 20,
        filters: {
            q?: string;
            specialty?: string;
            priceMin?: number;
            priceMax?: number;
            minExperience?: number;
            availableOnly?: boolean;
            sort?: DoctorSort;
        } = {}
    ) {
        const where: any = {
            verificationStatus: "approved",
            // Away mode: doctors inside an away window are hidden from discovery
            OR: [{ awayUntil: null }, { awayUntil: { lte: new Date() } }],
        };
        if (filters.specialty) where.specialty = filters.specialty;
        if (filters.priceMin !== undefined || filters.priceMax !== undefined) {
            where.price = {};
            if (filters.priceMin !== undefined) where.price.gte = filters.priceMin;
            if (filters.priceMax !== undefined) where.price.lte = filters.priceMax;
        }
        if (filters.minExperience !== undefined) where.experience = { gte: filters.minExperience };
        if (filters.availableOnly) where.availability = "Available";
        if (filters.q) {
            const q = filters.q.trim();
            // Merge with the away-mode OR clause via AND
            where.AND = [
                {
                    OR: [
                        { specialty: { contains: q } },
                        { bio: { contains: q } },
                        { user: { name: { contains: q } } },
                    ],
                },
            ];
        }
        const orderBy = SORT_ORDERS[filters.sort || "rating"];

        const isUncachedQuery =
            filters.q ||
            filters.specialty ||
            filters.priceMin !== undefined ||
            filters.priceMax !== undefined ||
            filters.minExperience !== undefined ||
            filters.availableOnly ||
            (filters.sort && filters.sort !== "rating");

        // Page 1 default directory is cached for 60s (Redis); misses hit the DB.
        if (page === 1 && !isUncachedQuery) {
            const cached = await cacheGet<any>(DIRECTORY_CACHE_KEY);
            if (cached) return cached;
        }
        const skip = (page - 1) * limit;
        const take = Math.min(limit, 50);
        const [rows, total] = await Promise.all([
            prisma.doctor.findMany({
                where,
                include: {
                    user: {
                        select: {
                            name: true,
                            avatar: true,
                            phone_number: true,
                        },
                    },
                    _count: { select: { reviews: true } },
                },
                orderBy,
                skip,
                take,
            }),
            prisma.doctor.count({ where }),
        ]);
        const result = { rows, total, page, totalPages: Math.ceil(total / take) };
        if (page === 1 && !isUncachedQuery) await cacheSet(DIRECTORY_CACHE_KEY, result, 60);
        return result;
    }

    static async getDoctorById(id: number) {
        const cached = await cacheGet<any>(doctorDetailKey(id));
        if (cached) return cached;
        const doctor = await prisma.doctor.findUnique({
            where: { id, verificationStatus: "approved" },
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
        if (doctor) await cacheSet(doctorDetailKey(id), doctor, 120);
        return doctor;
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

    static async getDoctorAnalytics(doctorId: number) {
        const now = new Date();

        // Status breakdown (all time)
        const statuses = await prisma.appointment.groupBy({
            by: ["status"],
            where: { doctorId },
            _count: { status: true },
        });
        const statusBreakdown = Object.fromEntries(statuses.map((s) => [s.status, s._count.status]));
        const total = statuses.reduce((sum, s) => sum + s._count.status, 0);
        const cancelled = statusBreakdown["cancelled"] || 0;
        const cancellationRate = total > 0 ? Math.round((cancelled / total) * 1000) / 10 : 0;

        // Last 6 months: completed bookings + revenue, reviews avg rating
        const months: { key: string; label: string; revenue: number; bookings: number; avgRating: number | null }[] = [];
        for (let i = 5; i >= 0; i--) {
            const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
            const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
            months.push({ key, label: start.toLocaleDateString("en-GB", { month: "short" }), revenue: 0, bookings: 0, avgRating: null });
        }

        const completed = await prisma.appointment.findMany({
            where: { doctorId, status: "completed", appointmentDate: { gte: months[0] ? new Date(months[0].key + "-01") : new Date() } },
            include: { doctor: { select: { price: true } } },
        });

        for (const app of completed) {
            const d = new Date(app.appointmentDate);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            const month = months.find((m) => m.key === key);
            if (month) {
                month.bookings += 1;
                month.revenue += app.doctor.price || 0;
            }
        }

        const reviews = await prisma.review.findMany({
            where: { doctorId, createdAt: { gte: new Date(now.getFullYear(), now.getMonth() - 5, 1) } },
            select: { rating: true, createdAt: true },
        });
        const ratingByMonth = new Map<string, { sum: number; count: number }>();
        for (const r of reviews) {
            const d = new Date(r.createdAt);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            const agg = ratingByMonth.get(key) || { sum: 0, count: 0 };
            agg.sum += r.rating;
            agg.count += 1;
            ratingByMonth.set(key, agg);
        }
        for (const m of months) {
            const agg = ratingByMonth.get(m.key);
            m.avgRating = agg && agg.count > 0 ? Math.round((agg.sum / agg.count) * 10) / 10 : null;
        }

        // Patient mood trend: avg mood (last 30 days) across the doctor's patients
        const moodAgg = await prisma.moodEntry.aggregate({
            where: {
                createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
                user: { appointments: { some: { doctorId, status: "completed" } } },
            },
            _avg: { mood: true },
            _count: { mood: true },
        });

        return {
            statusBreakdown,
            totalAppointments: total,
            cancellationRate,
            monthly: months,
            patientMood: {
                average: moodAgg._avg.mood ? Math.round(moodAgg._avg.mood * 10) / 10 : null,
                entries: moodAgg._count.mood,
            },
        };
    }

    static async getSlots(doctorId: number) {
        const doctor = await prisma.doctor.findUnique({
            where: { id: doctorId },
            select: { awayUntil: true },
        });
        const where: any = { doctorId };
        // Hide slots inside the away window from patients (and the doctor's own view)
        if (doctor?.awayUntil) {
            where.date = { gte: doctor.awayUntil };
        }
        return await prisma.consultationSlot.findMany({
            where,
            orderBy: [{ date: "desc" }, { startTime: "asc" }],
        });
    }

    static async setAway(doctorId: number, awayUntil: string | null) {
        let until: Date | null = null;
        if (awayUntil) {
            until = parseLocalDate(awayUntil);
            if (isNaN(until.getTime())) throw new Error("Invalid away date");
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (until < today) throw new Error("Away date must be in the future");
        }
        await prisma.doctor.update({ where: { id: doctorId }, data: { awayUntil: until } });
        invalidateDoctorCache(doctorId);
        return { awayUntil: until };
    }

    static async regeneratePattern(patternId: number, doctorId: number) {
        const pattern = await prisma.availabilityPattern.findFirst({
            where: { id: patternId, doctorId },
        });
        if (!pattern) throw new Error("Pattern not found");

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const horizon = new Date(today);
        horizon.setDate(horizon.getDate() + 56); // 8 weeks

        const created: { date: string; startTime: string; endTime: string }[] = [];
        const cursor = new Date(today);
        // Align to the pattern's weekday
        let offset = (pattern.weekday - ((cursor.getDay() + 6) % 7) + 7) % 7;
        cursor.setDate(cursor.getDate() + offset);
        if (cursor < today) cursor.setDate(cursor.getDate() + 7);

        for (const d = new Date(cursor); d <= horizon; d.setDate(d.getDate() + 7)) {
            const dayStart = new Date(d);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(dayStart);
            dayEnd.setDate(dayEnd.getDate() + 1);

            const exists = await prisma.consultationSlot.findFirst({
                where: {
                    doctorId,
                    date: { gte: dayStart, lt: dayEnd },
                    startTime: pattern.startTime,
                    endTime: pattern.endTime,
                },
            });
            if (exists) continue;

            await prisma.consultationSlot.create({
                data: {
                    doctorId,
                    date: dayStart,
                    startTime: pattern.startTime,
                    endTime: pattern.endTime,
                    isBooked: false,
                },
            });
            created.push({ date: localDateKey(dayStart), startTime: pattern.startTime, endTime: pattern.endTime });
        }

        invalidateDoctorCache(doctorId);
        return { generatedSlots: created };
    }

    static async createSlot(data: { doctorId: number; date: string; start_time: string; end_time: string }) {
        const slotDate = parseLocalDate(data.date);
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

        const slot = await prisma.consultationSlot.create({
            data: {
                doctorId: data.doctorId,
                date: slotDate,
                startTime: data.start_time,
                endTime: data.end_time,
                isBooked: false,
            },
        });
        invalidateDoctorCache(data.doctorId);
        return slot;
    }

    static async deleteSlot(slotId: number, doctorId: number) {
        const slot = await prisma.consultationSlot.findFirst({
            where: { id: slotId, doctorId },
        });

        if (!slot) throw new Error("Slot not found.");
        if (slot.isBooked) throw new Error("Cannot delete a booked slot.");

        const deleted = await prisma.consultationSlot.delete({
            where: { id: slotId },
        });
        invalidateDoctorCache(doctorId);
        return deleted;
    }

    /**
     * Weekly availability patterns: generates ConsultationSlots for the next
     * `weeks` occurrences of the weekday, skipping past dates and duplicates.
     */
    static async createPattern(
        doctorId: number,
        data: { weekday: number; start_time: string; end_time: string; activeFrom?: string; weeks?: number }
    ) {
        if (!Number.isInteger(data.weekday) || data.weekday < 0 || data.weekday > 6) {
            throw new Error("Weekday must be 0 (Monday) to 6 (Sunday)");
        }
        const start = timeToMinutes(data.start_time);
        const end = timeToMinutes(data.end_time);
        if (isNaN(start) || isNaN(end) || start >= end) throw new Error("Invalid time format (HH:MM)");

        const weeks = Math.min(Math.max(parseInt(String(data.weeks || 8)), 1), 12);
        const activeFrom = data.activeFrom ? parseLocalDate(data.activeFrom) : new Date();
        if (isNaN(activeFrom.getTime())) throw new Error("Invalid activeFrom date");

        // Reject overlapping patterns (same weekday + overlapping time range)
        const overlap = await prisma.availabilityPattern.findFirst({
            where: {
                doctorId,
                weekday: data.weekday,
                OR: [
                    { startTime: { lte: data.start_time }, endTime: { gt: data.start_time } },
                    { startTime: { lt: data.end_time }, endTime: { gte: data.end_time } },
                    { startTime: { gte: data.start_time }, endTime: { lte: data.end_time } },
                ],
            },
        });
        if (overlap) throw new Error("Pattern overlaps with an existing pattern");

        const pattern = await prisma.availabilityPattern.create({
            data: {
                doctorId,
                weekday: data.weekday,
                startTime: data.start_time,
                endTime: data.end_time,
                activeFrom,
            },
        });

        // Generate slots for the next N occurrences of this weekday
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const firstOccurrence = new Date(activeFrom);
        firstOccurrence.setHours(0, 0, 0, 0);
        // Align to the requested weekday (Monday = 0)
        let offset = (data.weekday - ((firstOccurrence.getDay() + 6) % 7) + 7) % 7;
        if (offset === 0 && firstOccurrence < today) offset = 7;
        if (offset === 0 && firstOccurrence.getTime() < activeFrom.getTime()) offset = 7;
        firstOccurrence.setDate(firstOccurrence.getDate() + offset);
        if (firstOccurrence < today) firstOccurrence.setDate(firstOccurrence.getDate() + 7);

        const created: { date: string; startTime: string; endTime: string }[] = [];
        for (let w = 0; w < weeks; w++) {
            const date = new Date(firstOccurrence);
            date.setDate(firstOccurrence.getDate() + w * 7);
            if (date < today) continue;

            const dayStart = new Date(date);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(dayStart);
            dayEnd.setDate(dayEnd.getDate() + 1);

            const exists = await prisma.consultationSlot.findFirst({
                where: {
                    doctorId,
                    date: { gte: dayStart, lt: dayEnd },
                    startTime: data.start_time,
                    endTime: data.end_time,
                },
            });
            if (exists) continue;

            await prisma.consultationSlot.create({
                data: {
                    doctorId,
                    date: dayStart,
                    startTime: data.start_time,
                    endTime: data.end_time,
                    isBooked: false,
                },
            });
            created.push({
                date: localDateKey(dayStart),
                startTime: data.start_time,
                endTime: data.end_time,
            });
        }

        // Waitlisted patients get notified about the freshly generated slots
        if (created.length > 0) {
            await WaitlistService.notifyWaiters(doctorId).catch(() => {});
        }

        invalidateDoctorCache(doctorId);
        return { pattern, generatedSlots: created };
    }

    static async getPatterns(doctorId: number) {
        return await prisma.availabilityPattern.findMany({
            where: { doctorId },
            orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
        });
    }

    static async deletePattern(patternId: number, doctorId: number) {
        const pattern = await prisma.availabilityPattern.findFirst({
            where: { id: patternId, doctorId },
        });
        if (!pattern) throw new Error("Pattern not found");
        await prisma.availabilityPattern.delete({ where: { id: patternId } });
        invalidateDoctorCache(doctorId);
        return { success: true };
    }

    // Therapy packages
    static async createPackage(
        doctorId: number,
        data: { name: string; description?: string; sessionCount: number; totalPrice: number }
    ) {
        if (!data.name?.trim()) throw new Error("Package name is required");
        if (data.sessionCount < 2 || data.sessionCount > 20) throw new Error("Session count must be 2-20");
        if (data.totalPrice <= 0) throw new Error("Total price must be positive");

        return await prisma.package.create({
            data: {
                doctorId,
                name: data.name.trim(),
                description: data.description?.trim() || null,
                sessionCount: data.sessionCount,
                totalPrice: data.totalPrice,
            },
        });
    }

    static async getPackages(doctorId: number, activeOnly = false) {
        return await prisma.package.findMany({
            where: { doctorId, ...(activeOnly ? { active: true } : {}) },
            orderBy: { createdAt: "desc" },
        });
    }

    static async deletePackage(packageId: number, doctorId: number) {
        const pkg = await prisma.package.findFirst({ where: { id: packageId, doctorId } });
        if (!pkg) throw new Error("Package not found");
        await prisma.package.update({ where: { id: packageId }, data: { active: false } });
        return { success: true };
    }

    static async purchasePackage(packageId: number, userId: number) {
        const pkg = await prisma.package.findFirst({ where: { id: packageId, active: true } });
        if (!pkg) throw new Error("Package not found or inactive");

        const purchase = await prisma.packagePurchase.create({
            data: { packageId, userId, sessionsLeft: pkg.sessionCount },
        });
        return { ...purchase, package: pkg };
    }

    static async getMyPackagePurchases(userId: number) {
        return await prisma.packagePurchase.findMany({
            where: { userId },
            include: { package: { include: { doctor: { include: { user: { select: { name: true } } } } } } },
            orderBy: { createdAt: "desc" },
        });
    }
}
