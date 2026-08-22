import { Router } from "express";
import { AIController } from "../controllers/ai.controller";
import { BriefingController } from "../controllers/briefing.controller";
import { authenticate } from "../middleware/auth.middleware";
import { requireDoctor } from "../middleware/role.middleware";
import { aiLimiter, skipInTest } from "../middleware/rateLimit.middleware";
import { validate } from "../middleware/validate.middleware";
import {
    GenerateQuestionsSchema,
    SubmitAnswersSchema,
    GenerateBriefingSchema,
    MatchDoctorsSchema,
} from "../schemas/ai.schema";

const router = Router();

router.use(authenticate);

// Gemini calls are rate-limited to protect against cost abuse
router.post("/pre-session", skipInTest(aiLimiter), validate(GenerateQuestionsSchema), AIController.getPreSessionQuestions);
router.get("/pre-session/:appointmentId", AIController.getPreSessionData);
router.post("/pre-session/answers", validate(SubmitAnswersSchema), AIController.submitAnswers);

// Doctor clinical briefing (restricted)
router.post("/briefing", requireDoctor, skipInTest(aiLimiter), validate(GenerateBriefingSchema), BriefingController.generate);
router.get("/briefing/:appointmentId", requireDoctor, BriefingController.get);

// Patient wellness suggestions
router.post("/resources", skipInTest(aiLimiter), AIController.getWellnessSuggestions);

// AI doctor matching (natural-language search)
router.post("/match-doctors", skipInTest(aiLimiter), validate(MatchDoctorsSchema), AIController.matchDoctors);

export default router;
