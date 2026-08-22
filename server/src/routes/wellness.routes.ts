import { Router } from "express";
import { WellnessController } from "../controllers/wellness.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import {
    LogMoodSchema,
    MoodHistorySchema,
    JournalEntrySchema,
    JournalListSchema,
    SubmitAssessmentSchema,
    AssessmentListSchema,
} from "../schemas/wellness.schema";

const router = Router();

router.use(authenticate);

router.post("/mood", validate(LogMoodSchema), WellnessController.logMood);
router.get("/mood", validate(MoodHistorySchema), WellnessController.getMoodHistory);
router.get("/mood/stats", WellnessController.getMoodStats);

router.post("/journal", validate(JournalEntrySchema), WellnessController.createJournalEntry);
router.get("/journal", validate(JournalListSchema), WellnessController.getJournalEntries);
router.put("/journal/:id", validate(JournalEntrySchema), WellnessController.updateJournalEntry);
router.delete("/journal/:id", WellnessController.deleteJournalEntry);
router.post("/journal/summarize", WellnessController.summarizeJournal);

router.post("/assessments", validate(SubmitAssessmentSchema), WellnessController.submitAssessment);
router.get("/assessments", validate(AssessmentListSchema), WellnessController.getAssessments);

export default router;
