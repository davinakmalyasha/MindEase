import { Router } from "express";
import { WellnessController } from "../controllers/wellness.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { LogMoodSchema, MoodHistorySchema } from "../schemas/wellness.schema";

const router = Router();

router.use(authenticate);

router.post("/mood", validate(LogMoodSchema), WellnessController.logMood);
router.get("/mood", validate(MoodHistorySchema), WellnessController.getMoodHistory);
router.get("/mood/stats", WellnessController.getMoodStats);

export default router;
