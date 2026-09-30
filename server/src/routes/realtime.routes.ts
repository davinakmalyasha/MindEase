import { Router } from "express";
import { RealtimeController } from "../controllers/realtime.controller";
import { authenticate } from "../middleware/auth.middleware";

const router = Router();

router.use(authenticate);

/**
 * Hand the caller a credential it can actually deliver to the WebSocket
 * service. See `RealtimeController.ticket` for why this exists.
 */
router.post("/ticket", RealtimeController.ticket);

export default router;
