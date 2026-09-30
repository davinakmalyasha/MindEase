import { Request, Response } from "express";
import { RiskQueueService } from "../services/riskQueue.service";
import { publicMessageFor } from "../utils/appError";
import { logger } from "../utils/logger";

/**
 * The clinician-facing queue of risk disclosures.
 *
 * A clinician only ever sees disclosures from patients they have a clinical
 * relationship with, or alerts explicitly assigned to them - the same scoping
 * rule that gates the pre-session briefing and the mood history. An
 * administrator sees everything.
 *
 * Every handler funnels through `publicMessageFor` rather than matching a
 * message substring, for the reason documented in appError.ts: a new
 * client-facing message used to silently become a 500.
 */
export class ClinicalSafetyController {
    static async listForDoctor(req: Request, res: Response) {
        try {
            const result = await RiskQueueService.listQueue(req.user!, {
                includeResolved: req.query.includeResolved === "true",
            });
            res.json({ status: "success", data: result.items, counts: result.counts });
        } catch (error: unknown) {
            logger.error({ err: (error as Error).message }, "Failed to list risk alerts");
            const { message, status } = publicMessageFor(error) ?? {
                message: "Failed to load the risk queue.",
                status: 500,
            };
            res.status(status).json({ status: "error", message });
        }
    }

    static async acknowledge(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            const updated = await RiskQueueService.acknowledge(req.user!, id);
            res.json({ status: "success", data: updated });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? {
                message: "Failed to acknowledge the alert.",
                status: 500,
            };
            res.status(status).json({ status: "error", message });
        }
    }

    static async resolve(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            const note = typeof req.body?.note === "string" ? req.body.note.trim() : null;
            const updated = await RiskQueueService.resolve(req.user!, id, note);
            res.json({ status: "success", data: updated });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? {
                message: "Failed to resolve the alert.",
                status: 500,
            };
            res.status(status).json({ status: "error", message });
        }
    }
}
