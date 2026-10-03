import { Router } from "express";
import { FollowUpController } from "../controllers/followUp.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { idParam } from "../schemas/params.schema";
import { SuggestFollowUpSchema } from "../schemas/appointment.schema";

const router = Router();

router.use(authenticate);

router.post("/appointments/:id/follow-up", validate(SuggestFollowUpSchema), FollowUpController.suggest);
router.get("/appointments/:id/follow-up", FollowUpController.get);
router.post("/follow-ups/:id/accept", validate(idParam), FollowUpController.accept);
router.post("/follow-ups/:id/decline", validate(idParam), FollowUpController.decline);

export default router;
