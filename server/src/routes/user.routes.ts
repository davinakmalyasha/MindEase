import { Router } from "express";
import { UserController } from "../controllers/user.controller";
import { authenticate } from "../middleware/auth.middleware";

const router = Router();

router.use(authenticate);

router.get("/profile", UserController.getProfile);
router.put("/profile", UserController.updateProfile);

export default router;
