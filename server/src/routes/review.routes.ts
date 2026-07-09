import { Router } from "express";
import { ReviewController } from "../controllers/review.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { CreateReviewSchema } from "../schemas/wellness.schema";

const router = Router();

// POST /api/reviews - Create a new review (authenticated patients only)
router.post("/", authenticate, validate(CreateReviewSchema), ReviewController.createReview);

// GET /api/reviews/doctor/:doctorId - Get all reviews for a doctor (public)
router.get("/doctor/:doctorId/summary", ReviewController.getDoctorRatingSummary);
router.get("/doctor/:doctorId", ReviewController.getDoctorReviews);

export default router;
