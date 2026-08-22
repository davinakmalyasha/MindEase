import { Router } from "express";
import { NotificationController } from "../controllers/notification.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { NotificationPrefsSchema } from "../schemas/notification.schema";

const router = Router();

router.get("/", authenticate, NotificationController.getNotifications);
router.get("/unread-count", authenticate, NotificationController.getUnreadCount);
router.get("/preferences", authenticate, NotificationController.getPreferences);
router.put("/preferences", authenticate, validate(NotificationPrefsSchema), NotificationController.updatePreferences);
router.patch("/:id/read", authenticate, NotificationController.markAsRead);
router.patch("/read-all", authenticate, NotificationController.markAllAsRead);

export default router;
