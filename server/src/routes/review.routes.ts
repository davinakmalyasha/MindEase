import { Router } from "express";
import { ReviewController } from "../controllers/review.controller";
import { authenticate } from "../middleware/auth.middleware";

const router = Router();

// POST /api/reviews - Create a new review (authenticated patients only)
router.post("/", authenticate, ReviewController.createReview);

// GET /api/reviews/doctor/:doctorId - Get all reviews for a doctor (public)
router.get("/doctor/:doctorId", ReviewController.getDoctorReviews);

// GET /api/reviews/doctor/:doctorId/summary - Get rating summary (public)
router.get("/doctor/:doctorId/summary", ReviewController.getDoctorRatingSummary);

export default router;
