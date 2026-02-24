import { Router } from "express";
import { NotificationController } from "../controllers/notification.controller";
import { authenticate } from "../middleware/auth.middleware";

const router = Router();

router.get("/", authenticate, NotificationController.getNotifications);
router.get("/unread-count", authenticate, NotificationController.getUnreadCount);
router.patch("/:id/read", authenticate, NotificationController.markAsRead);
router.patch("/read-all", authenticate, NotificationController.markAllAsRead);

export default router;
