import { Request, Response } from "express";
import { ReviewService } from "../services/review.service";

export class ReviewController {
    static async createReview(req: Request, res: Response) {
        try {
            const userId = (req as any).user.id;
            const { doctorId, appointmentId, rating, comment } = req.body;

            if (!doctorId || !appointmentId || !rating || !comment) {
                return res.status(400).json({ status: "error", message: "All fields are required." });
            }

            if (rating < 1 || rating > 5) {
                return res.status(400).json({ status: "error", message: "Rating must be between 1 and 5." });
            }

            const result = await ReviewService.createReview({
                userId,
                doctorId: Number(doctorId),
                appointmentId: Number(appointmentId),
                rating: Number(rating),
                comment,
            });

            res.status(201).json(result);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to create review.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async getDoctorReviews(req: Request, res: Response) {
        try {
            const doctorId = Number(req.params.doctorId);
            const reviews = await ReviewService.getReviewsByDoctor(doctorId);
            res.json(reviews);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to fetch reviews.";
            res.status(500).json({ status: "error", message });
        }
    }

    static async getDoctorRatingSummary(req: Request, res: Response) {
        try {
            const doctorId = Number(req.params.doctorId);
            const summary = await ReviewService.getDoctorRatingSummary(doctorId);
            res.json(summary);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to fetch rating summary.";
            res.status(500).json({ status: "error", message });
        }
    }
}
