import { Router } from "express";
import { AdminController } from "../controllers/admin.controller";
import { authenticate } from "../middleware/auth.middleware";
import { requireAdmin } from "../middleware/role.middleware";
import { validate } from "../middleware/validate.middleware";
import { UpdateUserRoleSchema } from "../schemas/admin.schema";

const router = Router();

router.use(authenticate, requireAdmin);

router.get("/stats", AdminController.getStats);
router.get("/users", AdminController.getUsers);
router.patch("/users/:id/role", validate(UpdateUserRoleSchema), AdminController.updateUserRole);
router.patch("/users/:id/ban", AdminController.toggleBan);
router.get("/audit-logs", AdminController.getAuditLogs);

export default router;
