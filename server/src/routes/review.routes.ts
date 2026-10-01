import { Router } from "express";
import { ReviewController } from "../controllers/review.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { perUserWriteLimiter } from "../middleware/rateLimit.middleware";
import { CreateReviewSchema, ReplyReviewSchema, ReportReviewSchema } from "../schemas/wellness.schema";

const router = Router();

// Reporting is rate-limited per doctor, and tightly. A clinician moderating
// their own profile reporting every review in a burst is the intended use, so
// the allowance is small: the only automated pattern it has to absorb is a
// patient reporting a handful of reviews, and the previous ceiling was the
// 300/15min global limit shared with the entire API.
const reportRate = perUserWriteLimiter(10, 60 * 60 * 1000, "review report");

// POST /api/reviews - Create a new review (authenticated patients only)
router.post("/", authenticate, validate(CreateReviewSchema), ReviewController.createReview);

// POST /api/reviews/:id/reply - Doctor replies to a review on their own profile
router.post("/:id/reply", authenticate, validate(ReplyReviewSchema), ReviewController.replyToReview);

// POST /api/reviews/:id/report - Doctor reports a review on their own profile
router.post("/:id/report", authenticate, reportRate, validate(ReportReviewSchema), ReviewController.reportReview);

// GET /api/reviews/doctor/:doctorId - Get all reviews for a doctor (public)
router.get("/doctor/:doctorId/summary", ReviewController.getDoctorRatingSummary);
router.get("/doctor/:doctorId", ReviewController.getDoctorReviews);

export default router;
