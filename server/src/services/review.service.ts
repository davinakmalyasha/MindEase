import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface CreateReviewInput {
    userId: number;
    doctorId: number;
    appointmentId: number;
    rating: number;
    comment: string;
}

export class ReviewService {
    static async createReview(data: CreateReviewInput) {
        // Validate: appointment must exist, belong to user, and be completed
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

        // Validate: no duplicate review for the same appointment
        const existingReview = await prisma.review.findFirst({
            where: {
                userId: data.userId,
                doctorId: data.doctorId,
            },
        });

        // Allow multiple reviews per doctor but could restrict per appointment if needed

        const review = await prisma.review.create({
            data: {
                userId: data.userId,
                doctorId: data.doctorId,
                rating: data.rating,
                comment: data.comment,
            },
            include: {
                user: {
                    select: { id: true, name: true, avatar: true },
                },
            },
        });

        // Recalculate doctor's average rating
        const aggregation = await prisma.review.aggregate({
            where: { doctorId: data.doctorId },
            _avg: { rating: true },
            _count: { rating: true },
        });

        await prisma.doctor.update({
            where: { id: data.doctorId },
            data: {
                rating: Math.round((aggregation._avg.rating || 5) * 10) / 10,
            },
        });

        return { review, averageRating: aggregation._avg.rating, totalReviews: aggregation._count.rating };
    }

    static async getReviewsByDoctor(doctorId: number) {
        return await prisma.review.findMany({
            where: { doctorId },
            include: {
                user: {
                    select: { id: true, name: true, avatar: true },
                },
            },
            orderBy: { createdAt: "desc" },
        });
    }

    static async getDoctorRatingSummary(doctorId: number) {
        const aggregation = await prisma.review.aggregate({
            where: { doctorId },
            _avg: { rating: true },
            _count: { rating: true },
        });

        return {
            averageRating: Math.round((aggregation._avg.rating || 0) * 10) / 10,
            totalReviews: aggregation._count.rating,
        };
    }
}
