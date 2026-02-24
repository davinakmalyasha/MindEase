import { Router } from "express";
import { AdminController } from "../controllers/admin.controller";
import { authenticate } from "../middleware/auth.middleware";

const router = Router();

// Only authenticated admins should access these
// (For now authenticate, we can add is_admin middleware later for stricter check)
router.use(authenticate);

router.get("/stats", AdminController.getStats);
router.get("/users", AdminController.getUsers);

export default router;
