import { Router } from "express";
import rateLimit from "express-rate-limit";
import { SupportController } from "../controllers/support.controller";
import { CRISIS_HOTLINES } from "../services/clinicalSafety.service";
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

/**
 * SOS is rate-limited because it pages a real human, but a person in
 * escalating distress must never be denied help for pressing the button again.
 *
 * Two changes over the previous "3 per hour, plain 429":
 *   1. The response still carries the crisis hotlines, so the client can show
 *      a phone number on the very request that was throttled.
 *   2. A per-user account-level limit bounds the paging volume far more
 *      tightly than the per-IP window, which an attacker behind a rotating
 *      pool could otherwise walk straight through.
 */
const sosLimiter = skipInTest(
    rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 20,
        // Throttled, but never empty-handed.
        handler: (_req, res) =>
            res.status(429).json({
                status: "error",
                code: "SOS_THROTTLED",
                message:
                    "We have already been alerted for you recently. If this is an emergency, please call a hotline now.",
                data: {
                    doctorAlerted: false,
                    hotlines: CRISIS_HOTLINES,
                    crisisPage: "/crisis",
                },
            }),
        standardHeaders: true,
        legacyHeaders: false,
    })
);

router.post("/chat", authenticate, supportLimiter, validate(SupportChatSchema), SupportController.chat);
router.post("/sos", authenticate, sosLimiter, SupportController.sos);

export default router;
