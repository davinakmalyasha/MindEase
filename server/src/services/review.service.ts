import { prisma } from "../lib/prisma";
import { sanitize } from "../utils/sanitize";
import { invalidateDoctorCache } from "./doctor.service";
import { AuditService } from "./audit.service";



interface CreateReviewInput {
    userId: number;
    doctorId: number;
    appointmentId: number;
    rating: number;
    comment: string;
}

export class ReviewService {
    static async createReview(data: CreateReviewInput) {
        // Validate: appointment must exist, belong to user, match doctor, and be completed
        const appointment = await prisma.appointment.findFirst({
            where: {
                id: data.appointmentId,
                userId: data.userId,
                doctorId: data.doctorId,
                status: "completed",
            },
        });

        if (!appointment) {
            throw new Error("Invalid appointment or not eligible for review.");
        }

        // Enforce one review per appointment
        const existing = await prisma.review.findUnique({
            where: { appointmentId: data.appointmentId },
        });
        if (existing) {
            throw new Error("You have already reviewed this appointment.");
        }

        const review = await prisma.review.create({
            data: {
                userId: data.userId,
                doctorId: data.doctorId,
                appointmentId: data.appointmentId,
                rating: data.rating,
                comment: sanitize(data.comment),
            },
            include: {
                user: {
                    select: { id: true, name: true, avatar: true },
                },
            },
        });

        // Recalculate doctor's average rating (hidden reviews don't count)
        const aggregation = await prisma.review.aggregate({
            where: { doctorId: data.doctorId, hidden: false },
            _avg: { rating: true },
            _count: { rating: true },
        });

        await prisma.doctor.update({
            where: { id: data.doctorId },
            data: {
                rating: Math.round((aggregation._avg.rating || 5) * 10) / 10,
            },
        });

        invalidateDoctorCache(data.doctorId);

        return {
            review,
            averageRating: aggregation._avg.rating,
            totalReviews: aggregation._count.rating,
        };
    }

    static async getReviewsByDoctor(doctorId: number) {
        return await prisma.review.findMany({
            where: { doctorId, hidden: false },
            include: {
                user: {
                    select: { id: true, name: true, avatar: true },
                },
            },
            orderBy: { createdAt: "desc" },
        });
    }

    // Doctors may report reviews on their own profile (one open report per review)
    static async reportReview(reviewId: number, doctorUserId: number, reason: string) {
        const review = await prisma.review.findUnique({
            where: { id: reviewId },
            include: { doctor: { select: { userId: true } } },
        });
        if (!review) throw new Error("Review not found");
        if (review.doctor.userId !== doctorUserId) {
            throw new Error("Forbidden: you can only report reviews on your own profile");
        }

        const open = await prisma.reviewReport.findFirst({
            where: { reviewId, status: "open" },
        });
        if (open) throw new Error("This review already has an open report");

        const report = await prisma.reviewReport.create({
            data: { reviewId, reporterId: doctorUserId, reason: sanitize(reason).slice(0, 2000) },
        });

        await AuditService.log({
            action: "review.report",
            actorId: doctorUserId,
            targetType: "Review",
            targetId: reviewId,
            meta: { reportId: report.id, doctorId: review.doctorId },
        });

        return report;
    }

    // Shared recalculation used on create and when admins hide/unhide
    static async recalcDoctorRating(doctorId: number) {
        const aggregation = await prisma.review.aggregate({
            where: { doctorId, hidden: false },
            _avg: { rating: true },
            _count: { rating: true },
        });
        await prisma.doctor.update({
            where: { id: doctorId },
            data: {
                rating: aggregation._count.rating
                    ? Math.round((aggregation._avg.rating || 0) * 10) / 10
                    : 5.0,
            },
        });
        invalidateDoctorCache(doctorId);
    }

    static async getDoctorRatingSummary(doctorId: number) {
        const aggregation = await prisma.review.aggregate({
            where: { doctorId, hidden: false },
            _avg: { rating: true },
            _count: { rating: true },
        });

        // Rating distribution for the summary card
        const distribution = await prisma.review.groupBy({
            by: ["rating"],
            where: { doctorId, hidden: false },
            _count: { rating: true },
        });

        return {
            averageRating: Math.round((aggregation._avg.rating || 0) * 10) / 10,
            totalReviews: aggregation._count.rating,
            distribution: Object.fromEntries(distribution.map((d) => [d.rating, d._count.rating])),
        };
    }

    // Doctors may reply to reviews on their own profile (one reply, update-in-place)
    static async replyToReview(reviewId: number, doctorUserId: number, reply: string) {
        const review = await prisma.review.findUnique({
            where: { id: reviewId },
            include: { doctor: { select: { userId: true } } },
        });
        if (!review) throw new Error("Review not found");
        if (review.doctor.userId !== doctorUserId) {
            throw new Error("Forbidden: you can only reply to reviews on your own profile");
        }

        const cleaned = sanitize(reply.trim());
        if (!cleaned) throw new Error("Reply cannot be empty");

        const updated = await prisma.review.update({
            where: { id: reviewId },
            data: { reply: cleaned, repliedAt: new Date() },
        });

        await AuditService.log({
            action: "review.reply",
            actorId: doctorUserId,
            targetType: "Review",
            targetId: reviewId,
            meta: { doctorId: review.doctorId },
        });

        return updated;
    }
}
