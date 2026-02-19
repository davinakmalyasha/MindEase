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
            // Note: In real app we'd use multer for avatar upload
            // For now assuming data comes in body
            const updatedProfile = await UserService.updateProfile(userId, req.body);
            res.json({ status: "success", user: updatedProfile });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }
}
