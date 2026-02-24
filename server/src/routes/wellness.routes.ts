import { Router } from "express";
import { WellnessController } from "../controllers/wellness.controller";
import { authenticate } from "../middleware/auth.middleware";

const router = Router();

router.post("/mood", authenticate, WellnessController.logMood);
router.get("/mood", authenticate, WellnessController.getMoodHistory);
router.get("/mood/stats", authenticate, WellnessController.getMoodStats);

export default router;
