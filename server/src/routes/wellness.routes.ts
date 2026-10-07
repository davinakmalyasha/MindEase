import { Router } from "express";
import { WellnessController } from "../controllers/wellness.controller";
import { ClinicalSafetyController } from "../controllers/clinicalSafety.controller";
import { authenticate } from "../middleware/auth.middleware";
import { requireDoctor, requireClinicalStaff } from "../middleware/role.middleware";
import { validate } from "../middleware/validate.middleware";
import { aiLimiter, skipInTest } from "../middleware/rateLimit.middleware";
import {
    LogMoodSchema,
    MoodHistorySchema,
    JournalEntrySchema,
    JournalListSchema,
    JournalSummarizeSchema,
    SubmitAssessmentSchema,
    AssessmentListSchema,
    MoodStatsSchema,
    JournalIdSchema,
    ResolveRiskAlertSchema,
    TrajectorySchema,
    idParam,
} from "../schemas/wellness.schema";

const router = Router();

router.use(authenticate);

router.post("/mood", validate(LogMoodSchema), WellnessController.logMood);
router.get("/mood", validate(MoodHistorySchema), WellnessController.getMoodHistory);
router.get("/mood/stats", validate(MoodStatsSchema), WellnessController.getMoodStats);

router.post("/journal", validate(JournalEntrySchema), WellnessController.createJournalEntry);
router.get("/journal", validate(JournalListSchema), WellnessController.getJournalEntries);
router.put("/journal/:id", validate(idParam), validate(JournalEntrySchema), WellnessController.updateJournalEntry);
router.delete("/journal/:id", validate(JournalIdSchema), WellnessController.deleteJournalEntry);
// AI-backed, so metered: this previously ran with no limiter and no quota, and
// with no result cache, making it unmetered spend on a metered API key.
router.post("/journal/summarize", skipInTest(aiLimiter), validate(JournalSummarizeSchema), WellnessController.summarizeJournal);

router.post("/assessments", validate(SubmitAssessmentSchema), WellnessController.submitAssessment);
router.get("/assessments", validate(AssessmentListSchema), WellnessController.getAssessments);

// The clinician triage queue. Scoped to patients the requesting clinician
// actually has a clinical relationship with, or alerts explicitly assigned to
// them. The two are a disjunction, not a conjunction: an assignment survives a
// lapsed relationship, an unassigned alert does not. `RiskQueueService.listQueue`
// carries the reasoning.
//
// These three endpoints return the disclosure a patient made about thoughts of
// self-harm, so they are the highest-consequence surface in the API: every one
// of them filters server-side, and none of them trusts a client-supplied
// patient id.
// Clinician or admin, not `requireDoctor`: an admin is paged for out-of-hours
// disclosures and the service has an explicit admin branch for reading the whole
// queue. Acknowledging and resolving stay doctor-only, because a clinician
// signing off that they have dealt with a disclosure is a clinical act.
router.get("/risk-alerts", requireClinicalStaff, ClinicalSafetyController.listForDoctor);
router.post("/risk-alerts/:id/acknowledge", requireDoctor, validate(idParam), ClinicalSafetyController.acknowledge);
router.post("/risk-alerts/:id/resolve", requireDoctor, validate(idParam), validate(ResolveRiskAlertSchema), ClinicalSafetyController.resolve);

// Longitudinal screening trajectory. Distinct from GET /assessments, which
// returns the raw history: this returns a scored series with the instrument's
// bands, for plotting.
router.get("/assessments/trajectory", validate(TrajectorySchema), WellnessController.getAssessmentTrajectory);

export default router;
