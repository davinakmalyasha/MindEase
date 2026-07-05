import { Request, Response } from "express";
import { UserService } from "../services/user.service";

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
            const profileData = {
                ...req.body,
                avatar: req.file ? `/uploads/${req.file.filename}` : req.body.avatar,
            };

            const updatedProfile = await UserService.updateProfile(userId, profileData);
            res.json({ status: "success", data: { user: updatedProfile } });
        } catch (error: any) {
            console.error("[Update Profile Error]", error);
            res.status(500).json({ status: "error", message: error.message });
        }
    }
}
