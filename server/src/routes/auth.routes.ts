import { Router } from "express";
import { Request, Response, NextFunction } from "express";
import { AuthController } from "../controllers/auth.controller";
import { validate } from "../middleware/validate.middleware";
import { authLimiter } from "../middleware/rateLimit.middleware";
import { RegisterSchema, LoginSchema, GoogleAuthSchema } from "../schemas/auth.schema";

const router = Router();

const noop = (req: Request, res: Response, next: NextFunction) => next();
const rate = process.env.NODE_ENV === "test" ? noop : authLimiter;

router.post("/register", rate, validate(RegisterSchema), AuthController.register);
router.post("/login", rate, validate(LoginSchema), AuthController.login);
router.post("/google", rate, validate(GoogleAuthSchema), AuthController.googleLogin);
router.post("/refresh", rate, AuthController.refresh);
router.post("/logout", AuthController.logout);

export default router;
