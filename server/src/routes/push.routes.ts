import { Router } from "express";
import { PushController } from "../controllers/push.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { PushSubscribeSchema } from "../schemas/push.schema";

const router = Router();

router.use(authenticate);

router.get("/public-key", PushController.publicKey);
router.post("/subscribe", validate(PushSubscribeSchema), PushController.subscribe);
router.post("/unsubscribe", PushController.unsubscribe);

export default router;
