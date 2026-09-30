import { Router } from "express";
import { CarePlanController, SafetyPlanController } from "../controllers/carePlan.controller";
import { authenticate } from "../middleware/auth.middleware";
import { requireDoctor } from "../middleware/role.middleware";
import { validate } from "../middleware/validate.middleware";
import { idParam } from "../schemas/params.schema";
import {
    UpdateCarePlanSchema,
    CreateGoalSchema,
    UpdateGoalSchema,
    CreateStepSchema,
    SetStepDoneSchema,
    SaveSafetyPlanSchema,
} from "../schemas/carePlan.schema";

const router = Router();

router.use(authenticate);

// --- The patient's own care plan -------------------------------------------
//
// Created on first read, so a patient returning after weeks starts from their
// existing plan rather than an empty screen.
router.get("/care-plan", CarePlanController.getMine);
router.get("/care-plan/all", CarePlanController.list);
router.put("/care-plan/:id", validate(UpdateCarePlanSchema), CarePlanController.update);

// Goals and steps. Writable by the patient *or* by a clinician they see: what
// gets agreed in a session is a goal the patient can then see, edit, complete or
// drop. The access rule lives in the service, keyed off the plan's owner, so it
// cannot be forgotten by a route that forgets a middleware.
router.post("/care-plan/:id/goals", validate(CreateGoalSchema), CarePlanController.addGoal);
router.put("/care-plan/goals/:id", validate(UpdateGoalSchema), CarePlanController.updateGoal);
router.delete("/care-plan/goals/:id", validate(idParam), CarePlanController.deleteGoal);
router.post("/care-plan/goals/:id/steps", validate(CreateStepSchema), CarePlanController.addStep);
router.patch("/care-plan/steps/:id", validate(SetStepDoneSchema), CarePlanController.setStepDone);

// --- Safety plan ------------------------------------------------------------
//
// Patient-owned and never generated. `getMine`/`saveMine` take no patient id at
// all: the only patient a caller can act on is themselves, so there is no
// parameter to get wrong.
router.get("/safety-plan", SafetyPlanController.getMine);
router.put("/safety-plan", validate(SaveSafetyPlanSchema), SafetyPlanController.saveMine);

// The clinician-facing read. Separate from the above so the access check is
// visible at the route rather than implied by a query parameter that could name
// anyone.
router.get("/safety-plan/patient/:id", requireDoctor, validate(idParam), SafetyPlanController.getForPatient);
router.post("/safety-plan/patient/:id/reviewed", requireDoctor, validate(idParam), SafetyPlanController.markReviewed);

export default router;
