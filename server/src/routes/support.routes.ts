import { Router } from "express";
import { SupportController } from "../controllers/support.controller";
import { CRISIS_HOTLINES } from "../services/clinicalSafety.service";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { sharedLimiter, skipInTest } from "../middleware/rateLimit.middleware";
import { SupportChatSchema } from "../schemas/support.schema";

const router = Router();

// Generous but bounded: support chat is conversational, not an API abuse target.
//
// `sharedLimiter` rather than a bare `rateLimit({...})`, which had this on the
// per-process `MemoryStore`. Both limiters in this file were built that way, so
// the SOS bound was doubled on two replicas and reset on every rolling deploy -
// on the one endpoint where the bound is a safety ceiling rather than a cost
// control.
const supportLimiter = skipInTest(
    sharedLimiter("support", {
        windowMs: 10 * 60 * 1000,
        max: 60,
        message: { status: "error", message: "Too many chat messages, please slow down" }
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
    sharedLimiter("sos", {
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
            })
    })
);

router.post("/chat", authenticate, supportLimiter, validate(SupportChatSchema), SupportController.chat);
router.post("/sos", authenticate, sosLimiter, SupportController.sos);

export default router;
