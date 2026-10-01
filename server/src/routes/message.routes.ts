import { Router } from "express";
import { MessageController } from "../controllers/message.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import multer from "multer";
import path from "path";
import { SendMessageSchema, GetMessagesSchema, TypingSchema, ReactionSchema, MessageIdSchema } from "../schemas/message.schema";
import { perUserWriteLimiter } from "../middleware/rateLimit.middleware";

const upload = multer({
    storage: multer.memoryStorage(),
    // Every limit here, not just the file size.
    //
    // `user.routes.ts` already works this way, with a comment explaining why:
    // multer's default `fieldSize` is 1MB and its default `fields` is Infinity,
    // so a request carrying a 1-byte file and thousands of 1MB text fields
    // buffers hundreds of megabytes in process RAM. It needs only a `canChat`
    // relationship, which any registered patient with one appointment has, and
    // unbounded memory growth is an OOM kill of the API - taking the reminder
    // and check-in cron jobs, which run in the same process, with it.
    //
    // `parts` is `fields + files`, and multer errors past it, so it is the real
    // backstop rather than belt-and-braces.
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
        fieldSize: 64 * 1024,
        fields: 8,
        files: 1,
        parts: 9,
    },
    fileFilter: (req, file, cb) => {
        // Extension AND MIME. The extension is what determines the served
        // `Content-Type` - express.static derives it from the sanitised
        // filename, not from the client-supplied mimetype - so a client
        // claiming `image/png` for an `.svg` still fails here.
        //
        // No `.svg` and no `.html`, deliberately. The directory is served from
        // the API's own origin, so an SVG upload would be stored XSS on the
        // credential origin. helmet's `nosniff` already blocks a polyglot
        // `.jpg`; it does not block an SVG.
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
// Keyed on the user id in the session, not on IP. A per-IP limit here is
// defeated by one account behind one address, which is the normal case, and
// the only previous ceiling was the 300/15min global limit shared with the
// whole API.
router.post(
    "/:userId",
    perUserWriteLimiter(60, 10 * 60 * 1000, "message"),
    validate(SendMessageSchema),
    MessageController.sendMessage
);
router.delete("/:id", validate(MessageIdSchema), MessageController.deleteMessage);
router.put("/:id/reaction", validate(ReactionSchema), MessageController.setReaction);

export default router;
