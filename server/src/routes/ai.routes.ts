import { Router } from "express";
import { AIController } from "../controllers/ai.controller";
import { BriefingController } from "../controllers/briefing.controller";
import { authenticate } from "../middleware/auth.middleware";
import { requireDoctor } from "../middleware/role.middleware";
import { validate } from "../middleware/validate.middleware";
import {
    GenerateQuestionsSchema,
    SubmitAnswersSchema,
    GenerateBriefingSchema,
} from "../schemas/ai.schema";

const router = Router();

router.use(authenticate);

// Patient pre-session reflections
router.post("/pre-session", validate(GenerateQuestionsSchema), AIController.getPreSessionQuestions);
router.get("/pre-session/:appointmentId", AIController.getPreSessionData);
router.post("/pre-session/answers", validate(SubmitAnswersSchema), AIController.submitAnswers);

// Doctor clinical briefing (restricted)
router.post("/briefing", requireDoctor, validate(GenerateBriefingSchema), BriefingController.generate);
router.get("/briefing/:appointmentId", requireDoctor, BriefingController.get);

// Patient wellness suggestions
router.post("/resources", AIController.getWellnessSuggestions);

export default router;
