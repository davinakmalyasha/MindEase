import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { parseLocalDate, localDateKey, timeToMinutes, overlaps } from "../lib/date";
import { cacheGet, cacheSet, cacheDel } from "../lib/cache";
import { WaitlistService } from "./waitlist.service";
import { badRequest, conflict, notFound } from "../utils/appError";

const DIRECTORY_CACHE_KEY = "cache:doctors:directory";
const doctorDetailKey = (id: number) => `cache:doctors:detail:${id}`;

// Cache invalidation hooks — call after any doctor profile change.
export const invalidateDoctorCache = (doctorId?: number) =>
    cacheDel(DIRECTORY_CACHE_KEY, doctorId ? doctorDetailKey(doctorId) : "");

/**
 * Narrows a slot query to the dates a clinician is actually bookable on.
 *
 * "Away until X" means unavailable from now through the end of day X, so every
 * slot up to and including that day is hidden and only later ones are offered.
 * `awayUntil` is stored at local midnight, so the bound is the end of that day;
 * an elapsed window is ignored rather than hiding everything.
 *
 * The original comparison was `gte: awayUntil`, which hid the slots *before* the
 * away date and kept offering the ones inside the window — the exact opposite.
 *
 * Both the booking endpoint (`getSlots`) and the public profile
 * (`getDoctorById`) must apply this identically, otherwise the profile
 * advertises a slot that the booking endpoint then refuses.
 */
const applyAwayWindow = (
    where: Prisma.ConsultationSlotWhereInput,
    awayUntil: Date | null | undefined,
    today: Date
) => {
    if (!awayUntil) return;
    const awayEnd = new Date(awayUntil);
    awayEnd.setHours(23, 59, 59, 999);
    if (awayEnd >= today) where.date = { gt: awayEnd };
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
        // This endpoint is unauthenticated and cached for two minutes, so the
        // select is an explicit allowlist rather than a convenience include.
        //
        // It previously returned every doctor's email address and phone number
        // to anonymous callers, and included reviews an administrator had hidden
        // — a moderation action that was therefore reversible by anyone who
        // loaded the profile page.
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // The advertised slots must obey the same away window as the booking
        // endpoint. This nested query only filtered `isBooked: false`, so a
        // clinician on leave still published their pre-created slots here — the
        // one place an anonymous visitor sees them — and the patient only found
        // out on submit that the slot was unavailable.
        //
        // The bound lives on the doctor row, so it has to be read before the
        // query that filters on it. This mirrors `getSlots`; the two-minute
        // cache below keeps the extra round trip off the hot path.
        const doctorRow = await prisma.doctor.findUnique({
            where: { id },
            select: { awayUntil: true, availability: true },
        });

        const slotWhere: Prisma.ConsultationSlotWhereInput = {
            isBooked: false,
            date: { gte: today },
        };
        applyAwayWindow(slotWhere, doctorRow?.awayUntil, today);

        const doctor = await prisma.doctor.findUnique({
            where: { id, verificationStatus: "approved" },
            select: {
                id: true,
                specialty: true,
                bio: true,
                experience: true,
                price: true,
                rating: true,
                totalReviews: true,
                licenseNumber: true,
                licenseIssuer: true,
                languages: true,
                education: true,
                verificationStatus: true,
                // The clinician's own free-text availability label. Distinct
                // from the weekly patterns below and from the live slots above:
                // this is what the clinician typed, the other two are what the
                // system knows. Returned because the profile used to invent
                // hours when this was absent.
                availability: true,
                // The clinician's actual recurring schedule.
                //
                // A patient asking "who is treating me and when are they
                // available" was previously answered with a hardcoded
                // "Mon - Fri, 09:00 - 17:00" on a clinician who had never
                // entered any hours. The real pattern is here, and a clinician
                // who has set none returns an empty list, which the client
                // renders as "not published" rather than as a guess.
                availabilityPatterns: {
                    where: { activeUntil: null },
                    select: { weekday: true, startTime: true, endTime: true },
                    orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
                },
                user: {
                    select: {
                        id: true,
                        name: true,
                        avatar: true,
                        // No email, no phone. Contact details are only
                        // exchanged between a patient and a doctor once an
                        // appointment is confirmed.
                    },
                },
                _count: { select: { reviews: { where: { hidden: false } } } },
                reviews: {
                    // A hidden review must stay hidden everywhere, not just on
                    // the dedicated reviews endpoint.
                    where: { hidden: false },
                    select: {
                        id: true,
                        rating: true,
                        comment: true,
                        reply: true,
                        repliedAt: true,
                        createdAt: true,
                        user: { select: { id: true, name: true, avatar: true } },
                    },
                    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                    take: 50,
                },
                consultationSlots: {
                    where: slotWhere,
                    select: { id: true, date: true, startTime: true, endTime: true, isBooked: true },
                    orderBy: [{ date: "asc" }, { startTime: "asc" }],
                    take: 60,
                },
            },
        });
        if (doctor) await cacheSet(doctorDetailKey(id), doctor, 120);
        return doctor;
    }

    static async getDoctorStats(doctorId: number) {
        // Aggregated in the database. The previous version loaded the doctor's
        // entire booking history into memory and derived six counters with
        // `.filter()` in JavaScript — a 100k-booking doctor meant a 100k-row
        // fetch on every dashboard load.
        const now = new Date();

        const [byStatus, uniquePatients, upcoming] = await Promise.all([
            prisma.appointment.groupBy({
                by: ["status"],
                where: { doctorId },
                _count: { _all: true },
            }),
            prisma.appointment.findMany({
                where: { doctorId },
                distinct: ["userId"],
                select: { userId: true },
            }),
            prisma.appointment.count({
                where: { doctorId, status: "confirmed", appointmentDate: { gte: now } },
            }),
        ]);

        const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
        const totalAppointments = byStatus.reduce((sum, s) => sum + s._count._all, 0);

        return {
            totalPatients: uniquePatients.length,
            pendingAppointments: counts.pending ?? 0,
            confirmedAppointments: counts.confirmed ?? 0,
            completedAppointments: counts.completed ?? 0,
            upcomingAppointments: upcoming,
            totalAppointments,
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

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Past slots are never actionable, so they are excluded outright rather
        // than returned in full — this endpoint previously returned every slot
        // the doctor had ever created, with no limit.
        const where: Prisma.ConsultationSlotWhereInput = { doctorId, date: { gte: today } };
        applyAwayWindow(where, doctor?.awayUntil, today);

        return await prisma.consultationSlot.findMany({
            where,
            orderBy: [{ date: "asc" }, { startTime: "asc" }],
            take: 400,
        });
    }

    static async setAway(doctorId: number, awayUntil: string | null) {
        let until: Date | null = null;
        if (awayUntil) {
            until = parseLocalDate(awayUntil);
            if (isNaN(until.getTime())) throw badRequest("Invalid away date");
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (until < today) throw badRequest("Away date must be in the future");
        }
        await prisma.doctor.update({ where: { id: doctorId }, data: { awayUntil: until } });
        invalidateDoctorCache(doctorId);
        return { awayUntil: until };
    }

    static async regeneratePattern(patternId: number, doctorId: number) {
        const pattern = await prisma.availabilityPattern.findFirst({
            where: { id: patternId, doctorId },
        });
        if (!pattern) throw notFound("Pattern not found");

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const horizon = new Date(today);
        horizon.setDate(horizon.getDate() + 56); // 8 weeks

        const created: { date: string; startTime: string; endTime: string }[] = [];
        const cursor = new Date(today);
        // Align to the pattern's weekday
        const offset = (pattern.weekday - ((cursor.getDay() + 6) % 7) + 7) % 7;
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
        if (isNaN(slotDate.getTime())) throw badRequest("Invalid date");

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (slotDate < today) throw badRequest("Cannot create slots in the past");

        const start = timeToMinutes(data.start_time);
        const end = timeToMinutes(data.end_time);
        if (isNaN(start) || isNaN(end)) throw badRequest("Invalid time format (HH:MM)");
        if (start >= end) throw badRequest("End time must be after start time");

        const dayStart = new Date(slotDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        // Overlap is evaluated in application code, in minutes.
        //
        // The previous check pushed `startTime`/`endTime` comparisons into SQL
        // where they are `VARCHAR` and therefore compared *lexicographically*:
        // `"10:00" <= "9:00"` is true, so genuinely overlapping slots were
        // accepted. The appointment path had already been fixed for exactly
        // this reason; the slot path had not.
        const sameDay = await prisma.consultationSlot.findMany({
            where: { doctorId: data.doctorId, date: { gte: dayStart, lt: dayEnd } },
            select: { startTime: true, endTime: true },
        });

        const conflicts = sameDay.some((existing) =>
            overlaps(start, end, timeToMinutes(existing.startTime ?? ""), timeToMinutes(existing.endTime ?? ""))
        );
        if (conflicts) throw badRequest("Slot overlaps with an existing slot");

        // Uniqueness is also enforced by the database, so two concurrent
        // requests cannot both pass the check above and both insert.
        const slot = await prisma.consultationSlot
            .create({
                data: {
                    doctorId: data.doctorId,
                    date: slotDate,
                    startTime: data.start_time,
                    endTime: data.end_time,
                    isBooked: false,
                },
            })
            .catch(async (err: any) => {
                if (err?.code === "P2002") throw conflict("This exact slot already exists");
                throw err;
            });

        invalidateDoctorCache(data.doctorId);
        return slot;
    }

    static async deleteSlot(slotId: number, doctorId: number) {
        const slot = await prisma.consultationSlot.findFirst({
            where: { id: slotId, doctorId },
        });

        if (!slot) throw notFound("Slot not found.");
        if (slot.isBooked) throw badRequest("Cannot delete a booked slot.");

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
            throw badRequest("Weekday must be 0 (Monday) to 6 (Sunday)");
        }
        const start = timeToMinutes(data.start_time);
        const end = timeToMinutes(data.end_time);
        if (isNaN(start) || isNaN(end) || start >= end) throw badRequest("Invalid time format (HH:MM)");

        const weeks = Math.min(Math.max(parseInt(String(data.weeks || 8)), 1), 12);
        const activeFrom = data.activeFrom ? parseLocalDate(data.activeFrom) : new Date();
        if (isNaN(activeFrom.getTime())) throw badRequest("Invalid activeFrom date");

        // Reject overlapping patterns (same weekday + overlapping time range).
        //
        // Overlap is computed in JavaScript, in minutes, and the database filter
        // only narrows to the weekday. This query previously pushed the times
        // into SQL `lte`/`lt`/`gte`/`gt` comparisons on VARCHAR columns, which
        // compare lexicographically: `"10:00" <= "9:00"` is true, so a 09:00
        // pattern was reported as overlapping an unrelated 10:00 one. The same
        // bug class had already been found and fixed in `createSlot` and in the
        // booking path; this was the third instance.
        //
        // It only looked correct because every caller sends zero-padded "HH:mm".
        // Nothing in the schema enforces that, so it was one unpadded input away
        // from breaking.
        const startMinutes = timeToMinutes(data.start_time);
        const endMinutes = timeToMinutes(data.end_time);
        if (startMinutes === null || endMinutes === null) {
            throw badRequest("Invalid time format; use HH:mm");
        }
        if (endMinutes <= startMinutes) {
            throw badRequest("End time must be after start time");
        }

        const sameWeekday = await prisma.availabilityPattern.findMany({
            where: { doctorId, weekday: data.weekday },
            select: { id: true, startTime: true, endTime: true },
        });
        const clashes = sameWeekday.some((p) => {
            const otherStart = timeToMinutes(p.startTime);
            const otherEnd = timeToMinutes(p.endTime);
            if (otherStart === null || otherEnd === null) return false;
            // Half-open intervals [start, end): touching endpoints are not an
            // overlap, so 09:00–12:00 and 12:00–15:00 can coexist.
            return startMinutes < otherEnd && otherStart < endMinutes;
        });
        if (clashes) throw badRequest("Pattern overlaps with an existing pattern");

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
        if (!pattern) throw notFound("Pattern not found");
        await prisma.availabilityPattern.delete({ where: { id: patternId } });
        invalidateDoctorCache(doctorId);
        return { success: true };
    }

    // Therapy packages
    static async createPackage(
        doctorId: number,
        data: { name: string; description?: string; sessionCount: number; totalPrice: number }
    ) {
        // Only a clinician who has passed verification may sell. A pending
        // profile could otherwise publish a purchasable package.
        const doctor = await prisma.doctor.findUnique({
            where: { id: doctorId },
            select: { verificationStatus: true },
        });
        if (!doctor) throw notFound("Doctor profile not found");
        if (doctor.verificationStatus !== "approved") {
            throw badRequest("Your profile must be verified before you can offer packages");
        }

        if (!data.name?.trim()) throw badRequest("Package name is required");
        // A single-session plan is a legitimate product (a one-off consultation
        // at a bundled rate), so the floor is 1 rather than 2.
        if (data.sessionCount < 1 || data.sessionCount > 20) throw badRequest("Session count must be 1-20");
        if (data.totalPrice <= 0) throw badRequest("Total price must be positive");
        if (data.totalPrice > 100_000_000) throw badRequest("Total price is unrealistically high");

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
        if (!pkg) throw notFound("Package not found");
        await prisma.package.update({ where: { id: packageId }, data: { active: false } });
        return { success: true };
    }

    /**
     * Grants a patient a purchased package.
     *
     * This used to mint an unlimited supply of free therapy packages: no
     * payment, no verification, no rate limit, and no uniqueness. Because
     * booking applied the package branch *before* the credit branch, an
     * attacker could then book a paid doctor's sessions for nothing, repeatedly.
     *
     * A purchase now requires either a confirmed payment or an explicit
     * administrative grant, and at most one live grant exists per
     * (user, package). `PaymentService` (Wave 3) will own the `paidAt` write;
     * until then the controller only accepts an admin grant, so the free-ride
     * path is closed rather than merely discouraged.
     */
    static async purchasePackage(
        packageId: number,
        userId: number,
        options: { paidAt?: Date | null; grantedByUserId?: number | null } = {}
    ) {
        const pkg = await prisma.package.findFirst({
            where: { id: packageId, active: true },
            include: { doctor: { select: { verificationStatus: true, userId: true } } },
        });
        if (!pkg) throw notFound("Package not found or inactive");

        if (pkg.doctor.verificationStatus !== "approved") {
            throw badRequest("This package is not currently available");
        }

        // A self-service purchase is refused until payment is wired up. Callers
        // that represent a genuine administrative grant pass `grantedByUserId`.
        if (!options.paidAt && !options.grantedByUserId) {
            throw badRequest("This package requires payment before it can be added to your account");
        }

        const purchase = await prisma.packagePurchase.create({
            data: {
                packageId,
                userId,
                sessionsLeft: pkg.sessionCount,
                paidAt: options.paidAt ?? null,
                grantedByUserId: options.grantedByUserId ?? null,
                // Snapshot the commercial terms, so a later price change cannot
                // retroactively alter what this grant was worth.
                totalPrice: pkg.totalPrice,
                sessionCount: pkg.sessionCount,
            },
        });
        return { ...purchase, package: pkg };
    }

    static async getMyPackagePurchases(userId: number) {
        return await prisma.packagePurchase.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                packageId: true,
                sessionsLeft: true,
                status: true,
                paidAt: true,
                createdAt: true,
                package: {
                    select: {
                        id: true,
                        name: true,
                        description: true,
                        sessionCount: true,
                        totalPrice: true,
                        doctor: { select: { id: true, user: { select: { name: true } } } },
                    },
                },
            },
        });
    }
}
