import { Router } from "express";
import { MessageController } from "../controllers/message.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { SendMessageSchema, GetMessagesSchema } from "../schemas/message.schema";

const router = Router();

router.use(authenticate);

router.get("/conversations", MessageController.getConversations);
router.get("/:userId/messages", validate(GetMessagesSchema), MessageController.getMessages);
router.post("/:userId", validate(SendMessageSchema), MessageController.sendMessage);

export default router;
