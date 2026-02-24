import { Request, Response } from "express";
import { UserService } from "../services/user.service";

export class UserController {
    static async getProfile(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user.id;
            const profile = await UserService.getProfile(userId);
            res.json(profile);
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async updateProfile(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user.id;

            // req.body will now contain the text fields since we use multer
            // req.file will contain the avatar if uploaded
            const profileData = {
                ...req.body,
                avatar: req.file ? `/uploads/${req.file.filename}` : req.body.avatar
            };

            const updatedProfile = await UserService.updateProfile(userId, profileData);
            res.json({ status: "success", user: updatedProfile });
        } catch (error: any) {
            console.error("[Update Profile Error]", error);
            res.status(500).json({ status: "error", message: error.message });
        }
    }
}
