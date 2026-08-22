import { Router } from "express";
import { ReviewController } from "../controllers/review.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { CreateReviewSchema, ReplyReviewSchema, ReportReviewSchema } from "../schemas/wellness.schema";

const router = Router();

// POST /api/reviews - Create a new review (authenticated patients only)
router.post("/", authenticate, validate(CreateReviewSchema), ReviewController.createReview);

// POST /api/reviews/:id/reply - Doctor replies to a review on their own profile
router.post("/:id/reply", authenticate, validate(ReplyReviewSchema), ReviewController.replyToReview);

// POST /api/reviews/:id/report - Doctor reports a review on their own profile
router.post("/:id/report", authenticate, validate(ReportReviewSchema), ReviewController.reportReview);

// GET /api/reviews/doctor/:doctorId - Get all reviews for a doctor (public)
router.get("/doctor/:doctorId/summary", ReviewController.getDoctorRatingSummary);
router.get("/doctor/:doctorId", ReviewController.getDoctorReviews);

export default router;
