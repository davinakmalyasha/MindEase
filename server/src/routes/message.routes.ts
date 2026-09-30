import { Router } from "express";
import { MessageController } from "../controllers/message.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import multer from "multer";
import path from "path";
import { SendMessageSchema, GetMessagesSchema, TypingSchema, ReactionSchema, MessageIdSchema } from "../schemas/message.schema";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const allowedExt = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf", ".doc", ".docx", ".txt"];
        const ext = path.extname(file.originalname).toLowerCase();
        const isImage = file.mimetype.startsWith("image/");
        if (!allowedExt.includes(ext) || (!isImage && !file.mimetype.startsWith("application/") && file.mimetype !== "text/plain")) {
            return cb(new Error("File type not allowed (images, PDF, DOC, TXT up to 5MB)."));
        }
        cb(null, true);
    },
});

const router = Router();

router.use(authenticate);

router.get("/conversations", MessageController.getConversations);
router.post("/upload", upload.single("file"), MessageController.uploadAttachment);
router.get("/:userId/messages", validate(GetMessagesSchema), MessageController.getMessages);
router.post("/:userId/typing", validate(TypingSchema), MessageController.typingIndicator);
router.post("/:userId", validate(SendMessageSchema), MessageController.sendMessage);
router.delete("/:id", validate(MessageIdSchema), MessageController.deleteMessage);
router.put("/:id/reaction", validate(ReactionSchema), MessageController.setReaction);

export default router;
