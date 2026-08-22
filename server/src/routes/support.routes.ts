import { Router } from "express";
import rateLimit from "express-rate-limit";
import { SupportController } from "../controllers/support.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { skipInTest } from "../middleware/rateLimit.middleware";
import { SupportChatSchema } from "../schemas/support.schema";

const router = Router();

// Generous but bounded: support chat is conversational, not an API abuse target.
const supportLimiter = skipInTest(
    rateLimit({
        windowMs: 10 * 60 * 1000,
        max: 60,
        message: { status: "error", message: "Too many chat messages, please slow down" },
        standardHeaders: true,
        legacyHeaders: false,
    })
);

// SOS is rate-limited tightly: it alerts a real human doctor.
const sosLimiter = skipInTest(
    rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 3,
        message: { status: "error", message: "SOS already sent — please call a hotline for immediate help" },
        standardHeaders: true,
        legacyHeaders: false,
    })
);

router.post("/chat", authenticate, supportLimiter, validate(SupportChatSchema), SupportController.chat);
router.post("/sos", authenticate, sosLimiter, SupportController.sos);

export default router;
