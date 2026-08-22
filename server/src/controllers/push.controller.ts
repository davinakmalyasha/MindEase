import { Request, Response } from "express";
import { PushService } from "../services/push.service";

export class PushController {
    static async subscribe(req: Request, res: Response) {
        try {
            const subscription = req.body;
            const result = await PushService.subscribe(req.user!.id, subscription, req.headers["user-agent"]);
            res.status(201).json({ status: "success", data: { id: result.id } });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to subscribe.";
            res.status(400).json({ status: "error", message });
        }
    }

    static async unsubscribe(req: Request, res: Response) {
        try {
            const { endpoint } = req.body;
            const result = await PushService.unsubscribe(req.user!.id, endpoint);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to unsubscribe.";
            res.status(400).json({ status: "error", message });
        }
    }

    static async publicKey(req: Request, res: Response) {
        res.json({ status: "success", data: { publicKey: process.env.VAPID_PUBLIC_KEY || null } });
    }
}
