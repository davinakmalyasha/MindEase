import { Router } from "express";
import { FollowUpController } from "../controllers/followUp.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { SuggestFollowUpSchema } from "../schemas/appointment.schema";

const router = Router();

router.use(authenticate);

router.post("/appointments/:id/follow-up", validate(SuggestFollowUpSchema), FollowUpController.suggest);
router.get("/appointments/:id/follow-up", FollowUpController.get);
router.post("/follow-ups/:id/accept", FollowUpController.accept);
router.post("/follow-ups/:id/decline", FollowUpController.decline);

export default router;
