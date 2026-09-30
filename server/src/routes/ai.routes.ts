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

// Metered because each can reach Gemini. `GET /pre-session/:appointmentId` is
// deliberately NOT metered here: it is a pure read of already-stored rows, so
// charging it the AI rate would penalise a patient reloading their own form.
//
// The loop that used to exist: `POST /pre-session/answers` was unmetered *and*
// nulls the cached briefing, while `GET /briefing/:appointmentId` was unmetered
// *and* regenerates the briefing from scratch when the cache is empty. Together
// they were a repeatable, unthrottled way to spend against a metered key.
router.post("/pre-session", skipInTest(aiLimiter), validate(GenerateQuestionsSchema), AIController.getPreSessionQuestions);
router.get("/pre-session/:appointmentId", AIController.getPreSessionData);
router.post("/pre-session/answers", skipInTest(aiLimiter), validate(SubmitAnswersSchema), AIController.submitAnswers);

// Doctor clinical briefing (restricted)
router.post("/briefing", requireDoctor, skipInTest(aiLimiter), validate(GenerateBriefingSchema), BriefingController.generate);
router.get("/briefing/:appointmentId", requireDoctor, skipInTest(aiLimiter), BriefingController.get);

// Patient wellness suggestions
router.post("/resources", skipInTest(aiLimiter), AIController.getWellnessSuggestions);

// AI doctor matching (natural-language search)
router.post("/match-doctors", skipInTest(aiLimiter), validate(MatchDoctorsSchema), AIController.matchDoctors);

export default router;
