import { Router } from "express";
import { Request, Response, NextFunction } from "express";
import { AccountController } from "../controllers/account.controller";
import { TwoFactorController } from "../controllers/twoFactor.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import {
    resetLimiter,
    twoFactorLimiter,
    accountLimiter,
    skipInTest,
} from "../middleware/rateLimit.middleware";
import {
    ChangePasswordSchema,
    ForgotPasswordSchema,
    ResetPasswordSchema,
    VerifyEmailSchema,
    ResendVerificationSchema,
    TwoFactorVerifySchema,
TwoFactorCodeSchema,
TwoFactorSetupSchema,
TwoFactorDisableSchema,
    DeleteAccountSchema,
} from "../schemas/auth.schema";

const router = Router();

const noop = (req: Request, res: Response, next: NextFunction) => next();
// Password reset and 2FA get their own buckets rather than sharing login's.
// They used to share one module-level limiter, so twenty anonymous requests
// against *any* of register / login / forgot-password / reset-password /
// verify-email / 2fa-verify denied a victim the ability to log in, to reset a
// forgotten password, or to complete 2FA, for fifteen minutes. On a mental
// health platform, at the moment someone is locked out of their own care.
const resetRate = process.env.NODE_ENV === "test" ? noop : resetLimiter;
const twoFactorRate = process.env.NODE_ENV === "test" ? noop : twoFactorLimiter;
const accountRate = skipInTest(accountLimiter);

// Public
router.post("/forgot-password", resetRate, accountRate, validate(ForgotPasswordSchema), AccountController.forgotPassword);
// Per-email as well as per-IP: a six-digit code is only 900k values, and a
// rotating IP pool defeats a per-IP cap entirely.
router.post("/reset-password", resetRate, accountRate, validate(ResetPasswordSchema), AccountController.resetPassword);
router.post("/verify-email", resetRate, validate(VerifyEmailSchema), AccountController.verifyEmail);
router.post("/resend-verification", resetRate, accountRate, validate(ResendVerificationSchema), AccountController.sendVerification);
// Six digits against a 30-second window is a one-in-a-million guess, so this
// gets both buckets: its own per-IP allowance and the per-account one, whose
// key falls back to the pending token for this route.
router.post("/2fa/verify", twoFactorRate, accountRate, validate(TwoFactorVerifySchema), TwoFactorController.verifyLogin);

// Authenticated
router.use(authenticate);
router.post("/change-password", validate(ChangePasswordSchema), AccountController.changePassword);
// Deleting an account irreversibly destroys a patient's entire treatment
// history, so the credential must be re-entered. A stolen 15-minute access
// token — or an XSS on a shared device — must not be sufficient on its own.
router.delete("/me", validate(DeleteAccountSchema), AccountController.deleteAccount);
router.get("/export", AccountController.exportData);
// Enrolment requires password confirmation, like every other privilege change on
// the account. A stolen access token must not be able to attach the attacker's
// own authenticator.
router.post("/2fa/setup", validate(TwoFactorSetupSchema), TwoFactorController.setup);
router.post("/2fa/enable", validate(TwoFactorCodeSchema), TwoFactorController.enable);
router.post("/2fa/disable", validate(TwoFactorDisableSchema), TwoFactorController.disable);

export default router;
