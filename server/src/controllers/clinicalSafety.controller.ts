import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { AuditService } from "../services/audit.service";
import { logger } from "../utils/logger";

/**
 * Doctor-facing queue of risk disclosures.
 *
 * A clinician can only ever see disclosures from patients they actually have a
 * clinical relationship with — the same scoping rule that gates the pre-session
 * briefing and the mood history. An administrator sees everything.
 */
export class ClinicalSafetyController {
    static async listForDoctor(req: Request, res: Response) {
        try {
            const actor = req.user!;
            const includeAcknowledged = req.query.includeAcknowledged === "true";

            const scope =
                actor.role === "admin"
                    ? {}
                    : {
                          // Only patients this clinician has a confirmed or
                          // completed appointment with.
                          user: {
                              appointments: {
                                  some: {
                                      doctor: { userId: actor.id },
                                      status: { in: ["confirmed", "completed"] },
                                  },
                              },
                          },
                      };

            const alerts = await prisma.riskAlert.findMany({
                where: {
                    ...scope,
                    ...(includeAcknowledged ? {} : { acknowledgedAt: null }),
                },
                orderBy: [{ level: "asc" }, { createdAt: "desc" }],
                take: 100,
                select: {
                    id: true,
                    level: true,
                    reason: true,
                    sourceType: true,
                    createdAt: true,
                    acknowledgedAt: true,
                    user: { select: { id: true, name: true, email: true } },
                },
            });

            // `level: "asc"` sorts alphabetically, which puts "urgent" after
            // "elevated". Re-order so the most urgent disclosure is first.
            const rank = { urgent: 0, elevated: 1 } as const;
            alerts.sort((a, b) => {
                const byLevel = rank[a.level as keyof typeof rank] - rank[b.level as keyof typeof rank];
                return byLevel !== 0 ? byLevel : b.createdAt.getTime() - a.createdAt.getTime();
            });

            res.json({ status: "success", data: alerts });
        } catch (error: any) {
            logger.error({ err: error.message }, "Failed to list risk alerts");
            res.status(500).json({ status: "error", message: "Internal Server Error" });
        }
    }

    static async acknowledge(req: Request, res: Response) {
        try {
            const actor = req.user!;
            const id = Number(req.params.id);

            const alert = await prisma.riskAlert.findUnique({
                where: { id },
                select: {
                    id: true,
                    userId: true,
                    acknowledgedAt: true,
                    user: {
                        select: {
                            appointments: {
                                where: { doctor: { userId: actor.id }, status: { in: ["confirmed", "completed"] } },
                                select: { id: true },
                                take: 1,
                            },
                        },
                    },
                },
            });

            if (!alert) return res.status(404).json({ status: "error", message: "Alert not found" });

            // Same ownership rule as the listing endpoint: a clinician cannot
            // acknowledge a disclosure for a patient they have never seen.
            if (actor.role !== "admin" && alert.user.appointments.length === 0) {
                return res.status(403).json({ status: "error", message: "Forbidden" });
            }

            if (alert.acknowledgedAt) {
                return res.status(400).json({ status: "error", message: "Alert already acknowledged" });
            }

            const updated = await prisma.riskAlert.update({
                where: { id },
                data: { acknowledgedAt: new Date(), acknowledgedById: actor.id },
                select: { id: true, level: true, acknowledgedAt: true, acknowledgedById: true },
            });

            await AuditService.log({
                action: "risk.acknowledged",
                actorId: actor.id,
                targetType: "RiskAlert",
                targetId: id,
                meta: { userId: alert.userId },
            }).catch(() => {});

            res.json({ status: "success", data: updated });
        } catch (error: any) {
            logger.error({ err: error.message }, "Failed to acknowledge risk alert");
            res.status(500).json({ status: "error", message: "Internal Server Error" });
        }
    }
}
