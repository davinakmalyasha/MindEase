import { Router } from "express";
import { AIController } from "../controllers/ai.controller";
import { authenticate } from "../middleware/auth.middleware";

const router = Router();

router.post("/pre-session", authenticate, AIController.getPreSessionQuestions);
router.post("/briefing", authenticate, AIController.getDoctorBriefing);
router.post("/resources", authenticate, AIController.getWellnessSuggestions);

export default router;
