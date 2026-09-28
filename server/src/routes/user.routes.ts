import { Router } from "express";
import { UserController } from "../controllers/user.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { UpdateProfileSchema } from "../schemas/user.schema";
import multer from "multer";
import path from "path";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_AVATAR_BYTES,
        // Multipart *fields* were previously unbounded: only the file had a
        // limit, so a 2 MB request could carry many megabytes of text fields.
        fieldSize: 64 * 1024,
        fields: 12,
        files: 1,
    },
    fileFilter: (req, file, cb) => {
        const allowed = [".jpg", ".jpeg", ".png", ".webp"];
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowed.includes(ext) || !file.mimetype.startsWith("image/")) {
            return cb(new Error("Only image files (jpg, png, jpeg, webp) up to 2MB are allowed."));
        }
        cb(null, true);
    },
});

const router = Router();

router.use(authenticate);

router.get("/profile", UserController.getProfile);
// Validated after the upload runs so multipart fields reach the validator.
router.put(
    "/profile",
    upload.single("avatar"),
    validate(UpdateProfileSchema),
    UserController.updateProfile
);

export default router;
