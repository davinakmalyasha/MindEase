import { Router } from "express";
import { Request, Response, NextFunction } from "express";
import { AccountController } from "../controllers/account.controller";
import { TwoFactorController } from "../controllers/twoFactor.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { authLimiter, accountLimiter, skipInTest } from "../middleware/rateLimit.middleware";
import {
    ChangePasswordSchema,
    ForgotPasswordSchema,
    ResetPasswordSchema,
    VerifyEmailSchema,
    ResendVerificationSchema,
    TwoFactorVerifySchema,
    TwoFactorCodeSchema,
    TwoFactorDisableSchema,
    DeleteAccountSchema,
} from "../schemas/auth.schema";

const router = Router();

const noop = (req: Request, res: Response, next: NextFunction) => next();
const rate = process.env.NODE_ENV === "test" ? noop : authLimiter;
const accountRate = skipInTest(accountLimiter);

// Public
router.post("/forgot-password", rate, accountRate, validate(ForgotPasswordSchema), AccountController.forgotPassword);
// Per-email as well as per-IP: a six-digit code is only 900k values, and a
// rotating IP pool defeats a per-IP cap entirely.
router.post("/reset-password", rate, accountRate, validate(ResetPasswordSchema), AccountController.resetPassword);
router.post("/verify-email", rate, validate(VerifyEmailSchema), AccountController.verifyEmail);
router.post("/resend-verification", rate, accountRate, validate(ResendVerificationSchema), AccountController.sendVerification);
router.post("/2fa/verify", rate, accountRate, validate(TwoFactorVerifySchema), TwoFactorController.verifyLogin);

// Authenticated
router.use(authenticate);
router.post("/change-password", validate(ChangePasswordSchema), AccountController.changePassword);
// Deleting an account irreversibly destroys a patient's entire treatment
// history, so the credential must be re-entered. A stolen 15-minute access
// token — or an XSS on a shared device — must not be sufficient on its own.
router.delete("/me", validate(DeleteAccountSchema), AccountController.deleteAccount);
router.get("/export", AccountController.exportData);
router.post("/2fa/setup", TwoFactorController.setup);
router.post("/2fa/enable", validate(TwoFactorCodeSchema), TwoFactorController.enable);
router.post("/2fa/disable", validate(TwoFactorDisableSchema), TwoFactorController.disable);

export default router;
