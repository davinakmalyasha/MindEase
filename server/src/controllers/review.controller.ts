import { Request, Response } from "express";
import { ReviewService } from "../services/review.service";
import { publicMessageFor } from "../utils/appError";

/** Query-string integers arrive as strings or arrays; anything unusable falls back. */
const clampInt = (raw: unknown, fallback: number, min: number, max: number) => {
    const value = Array.isArray(raw) ? raw[0] : raw;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.trunc(parsed), min), max);
};

export class ReviewController {
    static async createReview(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { doctorId, appointmentId, rating, comment } = req.body;

            const result = await ReviewService.createReview({
                userId,
                doctorId: Number(doctorId),
                appointmentId: Number(appointmentId),
                rating: Number(rating),
                comment,
            });

            res.status(201).json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to create review.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async getDoctorReviews(req: Request, res: Response) {
        try {
            const doctorId = Number(req.params.doctorId);
            if (!Number.isInteger(doctorId) || doctorId <= 0) {
                return res.status(400).json({ status: "error", message: "Invalid doctor id" });
            }
            // Clamped in the service too; validated here so a junk value is a
            // clear 400 rather than a silently-ignored parameter.
            const limit = clampInt(req.query.limit, 20, 1, 50);
            const offset = clampInt(req.query.offset, 0, 0, 100_000);

            const result = await ReviewService.getReviewsByDoctor(doctorId, limit, offset);
            res.json({ status: "success", data: result.reviews, pagination: {
                total: result.total,
                limit: result.limit,
                offset: result.offset,
            } });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to fetch reviews.", status: 500 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async getDoctorRatingSummary(req: Request, res: Response) {
        try {
            const doctorId = Number(req.params.doctorId);
            const summary = await ReviewService.getDoctorRatingSummary(doctorId);
            res.json({ status: "success", data: summary });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to fetch rating summary.", status: 500 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async replyToReview(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const reviewId = Number(req.params.id);
            const { reply } = req.body;

            const result = await ReviewService.replyToReview(reviewId, userId, reply);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to reply to review.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async reportReview(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const reviewId = Number(req.params.id);
            const { reason } = req.body;

            const result = await ReviewService.reportReview(reviewId, userId, reason);
            res.status(201).json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to report review.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }
}
