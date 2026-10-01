import { Router } from "express";
import { AdminController } from "../controllers/admin.controller";
import { authenticate } from "../middleware/auth.middleware";
import { requireAdmin } from "../middleware/role.middleware";
import { validate } from "../middleware/validate.middleware";
import { idParam } from "../schemas/params.schema";
import { UpdateUserRoleSchema, UpdateVerificationSchema, BroadcastSchema, ReviewReportStatusSchema } from "../schemas/admin.schema";

const router = Router();

router.use(authenticate, requireAdmin);

router.get("/stats", AdminController.getStats);
router.get("/users", AdminController.getUsers);
router.patch("/users/:id/role", validate(UpdateUserRoleSchema), AdminController.updateUserRole);
router.patch("/users/:id/ban", validate(idParam), AdminController.toggleBan);
router.get("/doctors/applications", AdminController.getDoctorApplications);
router.patch("/doctors/:id/verification", validate(UpdateVerificationSchema), AdminController.updateDoctorVerification);
router.post("/broadcast", validate(BroadcastSchema), AdminController.broadcast);
router.get("/audit-logs", AdminController.getAuditLogs);
router.get("/review-reports", AdminController.getReviewReports);
router.post("/reviews/:id/hide", validate(idParam), AdminController.hideReview);
router.post("/review-reports/:id/status", validate(ReviewReportStatusSchema), AdminController.resolveReviewReport);
router.get("/export/:kind", AdminController.exportCsv);

export default router;
