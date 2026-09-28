import { Request, Response } from "express";
import { UserService } from "../services/user.service";
import { saveFile, deleteFile } from "../lib/storage";
import { publicMessageFor } from "../utils/appError";
import { logger } from "../utils/logger";

export class UserController {
    static async getProfile(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const profile = await UserService.getProfile(userId);
            if (!profile) {
                return res.status(404).json({ status: "error", message: "Profile not found" });
            }
            res.json({ status: "success", data: profile });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
        }
    }

    static async updateProfile(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            let avatarUrl: string | undefined;
            let oldAvatar: string | null | undefined;

            if (req.file) {
                avatarUrl = await saveFile(req.file.buffer, req.file.originalname, req.file.mimetype);
                const current = await UserService.getProfile(userId);
                oldAvatar = current?.avatar;
            }

            // `req.body` is the validated, allow-listed object: unknown keys are
            // rejected by the schema and an avatar supplied in the body is
            // ignored, so the only way to change an avatar is a real upload.
            const updatedProfile = await UserService.updateProfile(userId, req.body, avatarUrl);

            // Clean up the replaced avatar (best-effort)
            if (avatarUrl && oldAvatar && oldAvatar !== avatarUrl) {
                await deleteFile(oldAvatar);
            }

            res.json({ status: "success", data: { user: updatedProfile } });
        } catch (error: any) {
            logger.error({ err: error?.message, userId: req.user?.id }, "Update profile failed");
            res.status(500).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again." });
        }
    }
}
