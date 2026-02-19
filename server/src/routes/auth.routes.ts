import { Router } from "express";
import { AuthController } from "../controllers/auth.controller";
import { validate } from "../middleware/validate.middleware";
import { authLimiter } from "../middleware/rateLimit.middleware";
import { RegisterSchema, LoginSchema, GoogleAuthSchema } from "../schemas/auth.schema";

const router = Router();

router.post("/register", validate(RegisterSchema), AuthController.register);
router.post("/login", authLimiter, validate(LoginSchema), AuthController.login);
router.post("/google", validate(GoogleAuthSchema), AuthController.googleLogin);
router.post("/refresh", AuthController.refresh);
router.post("/logout", AuthController.logout);

export default router;
