import { Router } from "express";
import { UserController } from "../controllers/user.controller";
import { authenticate } from "../middleware/auth.middleware";
import multer from "multer";
import path from "path";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
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
router.put("/profile", upload.single("avatar"), UserController.updateProfile);

export default router;
