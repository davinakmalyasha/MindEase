import { Request, Response } from "express";
import { FollowUpService } from "../services/followUp.service";
import { publicMessageFor } from "../utils/appError";

export class FollowUpController {
    static async suggest(req: Request, res: Response) {
        try {
            const appointmentId = parseInt(req.params.id as string);
            const followUp = await FollowUpService.suggest(appointmentId, req.user!.id, {
                suggestedDate: req.body.suggestedDate,
                startTime: req.body.startTime,
                endTime: req.body.endTime,
                consultationType: req.body.consultationType,
                notes: req.body.notes,
            });
            res.status(201).json({ status: "success", data: followUp });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to suggest follow-up.";
            res.status(message.includes("Forbidden") ? 403 : 400).json({ status: "error", message });
        }
    }

    static async get(req: Request, res: Response) {
        try {
            const appointmentId = parseInt(req.params.id as string);
            const followUp = await FollowUpService.get(appointmentId, req.user!);
            res.json({ status: "success", data: followUp });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to fetch follow-up.";
            res.status(message.includes("Forbidden") ? 403 : 500).json({ status: "error", message });
        }
    }

    static async accept(req: Request, res: Response) {
        try {
            const followUpId = parseInt(req.params.id as string);
            const result = await FollowUpService.respond(followUpId, req.user!.id, true);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to accept follow-up.";
            res.status(message.includes("Forbidden") ? 403 : 400).json({ status: "error", message });
        }
    }

    static async decline(req: Request, res: Response) {
        try {
            const followUpId = parseInt(req.params.id as string);
            const result = await FollowUpService.respond(followUpId, req.user!.id, false);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const message = publicMessageFor(error)?.message ?? "Failed to decline follow-up.";
            res.status(message.includes("Forbidden") ? 403 : 400).json({ status: "error", message });
        }
    }
}
