import { Request, Response } from "express";
import { PreSessionService } from "../services/preSession.service";
import { publicMessageFor } from "../utils/appError";

export class BriefingController {
    static async generate(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const { appointmentId } = req.body;
            const result = await PreSessionService.getBriefing(Number(appointmentId), userId);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            // Was `message.startsWith("Forbidden") ? 403 : 400`, which broke as
            // soon as the service stopped prefixing the message with the word
            // "Forbidden" — the status now travels on the typed error itself.
            const { message, status } = publicMessageFor(error) ?? {
                message: "Failed to generate briefing.",
                status: 400,
            };
            res.status(status).json({ status: "error", message });
        }
    }

    static async get(req: Request, res: Response) {
        try {
            const userId = req.user!.id;
            const appointmentId = parseInt(req.params.appointmentId as string);
            if (!appointmentId) {
                return res.status(400).json({ status: "error", message: "Invalid appointment id" });
            }
            const result = await PreSessionService.getBriefing(appointmentId, userId);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? {
                message: "Failed to fetch briefing.",
                status: 400,
            };
            res.status(status).json({ status: "error", message });
        }
    }
}
