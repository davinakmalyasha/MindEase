import { Request, Response } from "express";
import { UserService } from "../services/user.service";
import { saveFile, deleteFile } from "../lib/storage";

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
            res.status(500).json({ status: "error", message: error.message });
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

            const profileData = {
                ...req.body,
            };

            const updatedProfile = await UserService.updateProfile(userId, profileData, avatarUrl ?? req.body.avatar);

            // Clean up the replaced avatar (best-effort)
            if (avatarUrl && oldAvatar && oldAvatar !== avatarUrl) {
                await deleteFile(oldAvatar);
            }

            res.json({ status: "success", data: { user: updatedProfile } });
        } catch (error: any) {
            console.error("[Update Profile Error]", error);
            res.status(500).json({ status: "error", message: error.message });
        }
    }
}
