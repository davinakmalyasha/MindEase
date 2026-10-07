/**
 * The clinician-facing triage worklist.
 *
 * Separate from `clinicalSafety.service`, which decides *whether* a signal is
 * clinically significant and escalates it. This module is the other half: what a
 * clinician does with the signals once they exist.
 *
 * The distinction matters because they have opposite failure modes. Missing a
 * signal is the dangerous bug and belongs in detection. Failing to *triage* one
 * - burying an urgent disclosure under an acknowledged one, or losing it the
 * moment it is acknowledged - is the bug that makes a safety feature
 * decorative, and it is entirely about presentation and state transitions.
 */
import { prisma } from "../lib/prisma";
import { assertFound, badRequest, forbidden } from "../utils/appError";
import { AuditService } from "./audit.service";
import type { RiskLevel } from "./clinicalSafety.service";

/**
 * Ordering rank for the queue. Lower sorts first.
 *
 * Explicitly a number returned to the client rather than a sort the client
 * re-implements. The previous endpoint sorted in the controller and returned an
 * unordered list with a `level` string, so any second consumer - the nav badge,
 * a future digest - had to reproduce the rule or invent its own.
 */
export type RiskPriority = 0 | 1 | 2 | 3;

const LEVEL_RANK: Record<RiskLevel, number> = { urgent: 0, elevated: 1 };

const URGENCY_LABEL: Record<RiskPriority, string> = {
    0: "urgent-unacknowledged",
    1: "urgent-acknowledged",
    2: "elevated-unacknowledged",
    3: "elevated-acknowledged",
};

/**
 * Urgent before elevated, then unacknowledged before acknowledged.
 *
 * Level leads deliberately, even though an unacknowledged item is "more mine"
 * than an acknowledged one. An acknowledged alert is not finished:
 * acknowledging means a clinician has seen it, not that it is dealt with, and
 * before the resolve transition existed those were the same state. Sorting
 * acknowledgement first would push a still-urgent disclosure below a routine
 * one purely because somebody had already glanced at it.
 *
 * Within a level, the unacknowledged item is the one that needs *this*
 * clinician, so it leads.
 */
export const priorityFor = (level: string, acknowledgedAt: Date | null): RiskPriority => {
    const byLevel = LEVEL_RANK[level as RiskLevel] ?? 2;
    const byAck = acknowledgedAt ? 1 : 0;
    return Math.min(3, byLevel * 2 + byAck) as RiskPriority;
};

export interface RiskQueuePatient {
    id: number;
    name: string | null;
    email: string | null;
    /** Most recent screening result, so triage needs one request not two. */
    lastAssessment: { type: string; score: number; severity: string; createdAt: Date } | null;
}

export interface RiskQueueItem {
    id: number;
    priority: RiskPriority;
    urgency: string;
    level: string;
    reason: string;
    sourceType: string;
    sourceId: number | null;
    createdAt: Date;
    acknowledgedAt: Date | null;
    acknowledgedById: number | null;
    resolutionNote: string | null;
    resolvedAt: Date | null;
    resolvedById: number | null;
    patient: RiskQueuePatient;
}

export interface RiskQueueCounts {
    unresolved: number;
    unacknowledged: number;
    urgentUnacknowledged: number;
}

const QUEUE_TAKE = 200;

/**
 * Does this actor have a clinical relationship with this patient?
 *
 * The same rule that gates the pre-session briefing and the mood history. A
 * clinician must not read a stranger's risk disclosure by guessing an id, and an
 * acknowledgement is a stronger act than a read: it asserts that a named human
 * took responsibility for responding.
 */
const treatsPatient = async (doctorUserId: number, userId: number): Promise<boolean> => {
    const row = await prisma.appointment.findFirst({
        where: { userId, status: { in: ["confirmed", "completed"] }, doctor: { userId: doctorUserId } },
        select: { id: true },
    });
    return row !== null;
};

/**
 * Counts computed from the same page the queue renders, so the badge and the
 * list can never disagree. A separate aggregate query would be marginally
 * cheaper but is a second source of truth, and a badge that says 3 above a list
 * showing 5 is worse than no badge.
 */
const summarise = (
    rows: { level: string; acknowledgedAt: Date | null; resolvedAt: Date | null }[]
): RiskQueueCounts => {
    const open = rows.filter((r) => r.resolvedAt === null);
    return {
        unresolved: open.length,
        unacknowledged: open.filter((r) => r.acknowledgedAt === null).length,
        urgentUnacknowledged: open.filter(
            (r) => r.acknowledgedAt === null && r.level === "urgent"
        ).length,
    };
};

export class RiskQueueService {
    /**
     * The queue a clinician works.
     *
     * Defaults to *unresolved*, not unacknowledged. The previous default
     * filtered on `acknowledgedAt: null`, which meant the moment a clinician
     * clicked acknowledge the alert vanished from the list - the exact opposite
     * of what a worklist should do, and it meant a clinician could not see what
     * they had already picked up and still owed an outcome on.
     */
    static async listQueue(
        actor: { id: number; role: string },
        options: { includeResolved?: boolean } = {}
    ): Promise<{ items: RiskQueueItem[]; counts: RiskQueueCounts }> {
        const isAdmin = actor.role === "admin";

        // Non-admins are scoped to their own patients, enforced in the query via
        // the relation rather than filtered afterwards, so an unauthorised alert
        // is never loaded into this process at all.
        const treatsOnly = {
            user: {
                appointments: {
                    some: {
                        doctor: { userId: actor.id },
                        status: { in: ["confirmed", "completed"] },
                    },
                },
            },
        };

        const rows = await prisma.riskAlert.findMany({
            where: {
                ...(options.includeResolved ? {} : { resolvedAt: null }),
                // One `OR`, not `treatsOnly AND (assigned OR unassigned)`.
                //
                // The previous shape ANDed the patient-relationship filter with
                // the assignment filter, so an alert *explicitly assigned* to a
                // clinician was still filtered out once the relationship that
                // created it lapsed - the appointment was cancelled, expired, or
                // simply fell outside the window. The comment above claimed the
                // opposite of what the code did, and `assertCanTriage` (which
                // uses a disjunction) disagreed with the list, so the alert was
                // invisible in the queue and in the nav badge, yet fully
                // acknowledge-able and resolvable by direct id. On a triage queue
                // that is silent loss of an open disclosure, which is the one
                // failure this feature exists to prevent.
                //
                // Each branch is now self-contained: assigned to me means mine
                // outright, and unassigned means mine only if I treat them.
                ...(isAdmin
                    ? {}
                    : {
                          OR: [
                              { assignedDoctorUserId: actor.id },
                              { assignedDoctorUserId: null, ...treatsOnly },
                          ],
                      }),
            },
            orderBy: [{ createdAt: "desc" }],
            take: QUEUE_TAKE,
            select: {
                id: true,
                level: true,
                reason: true,
                sourceType: true,
                sourceId: true,
                createdAt: true,
                acknowledgedAt: true,
                acknowledgedById: true,
                resolutionNote: true,
                resolvedAt: true,
                resolvedById: true,
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        assessments: {
                            orderBy: { createdAt: "desc" },
                            take: 1,
                            select: { type: true, score: true, severity: true, createdAt: true },
                        },
                    },
                },
            },
        });

        // `level` is a free string, so the database cannot order it by urgency.
        // The sort happens here on a bounded page, and the resulting priority
        // travels to the client as a number so the ordering is not re-derived
        // there.
        const items: RiskQueueItem[] = rows
            .map((row) => {
                const priority = priorityFor(row.level, row.acknowledgedAt);
                const latest = row.user.assessments[0];
                return {
                    id: row.id,
                    priority,
                    urgency: URGENCY_LABEL[priority],
                    level: row.level,
                    reason: row.reason,
                    sourceType: row.sourceType,
                    sourceId: row.sourceId,
                    createdAt: row.createdAt,
                    acknowledgedAt: row.acknowledgedAt,
                    acknowledgedById: row.acknowledgedById,
                    resolutionNote: row.resolutionNote,
                    resolvedAt: row.resolvedAt,
                    resolvedById: row.resolvedById,
                    patient: {
                        id: row.user.id,
                        name: row.user.name,
                        email: row.user.email,
                        lastAssessment: latest
                            ? {
                                  type: latest.type,
                                  score: latest.score,
                                  severity: latest.severity,
                                  createdAt: latest.createdAt,
                              }
                            : null,
                    },
                };
            })
            .sort((a, b) => {
                if (a.priority !== b.priority) return a.priority - b.priority;
                return b.createdAt.getTime() - a.createdAt.getTime();
            });

        // Reading the queue *is* reading every disclosure on it. Nothing
        // recorded that before, so "which clinicians have seen this patient's
        // crisis disclosures, and when" was unanswerable - which is precisely
        // the question an access log exists to answer.
        //
        // One row per item rather than one per request: a request that returns
        // thirty items discloses thirty disclosures, and a single entry naming
        // thirty patients would be useless for both questions a reviewer asks -
        // "who saw patient X" and "what did clinician Y look at".
        await Promise.all(
            items.map((item) =>
                AuditService.logRead({
                    actorId: actor.id,
                    subjectType: "RiskAlert",
                    subjectId: item.patient.id,
                    targetId: item.id,
                    via: "GET /api/wellness/risk-alerts",
                })
            )
        );

        return { items, counts: summarise(rows) };
    }

    /**
     * Marks an alert as seen. Explicit rather than idempotent: a second
     * acknowledge is a 400, not a silent no-op, because a client that retries
     * after a timeout needs to know whether its first call landed.
     *
     * The return type keeps the columns nullable even though this call has just
     * written them: they are nullable in the schema, so claiming otherwise here
     * would be a promise the query cannot keep, and a caller that trusted it
     * would be relying on a type assertion rather than on the data.
     */
    static async acknowledge(
        actor: { id: number; role: string },
        id: number
    ): Promise<{ id: number; acknowledgedAt: Date | null; acknowledgedById: number | null }> {
        const alert = assertFound(
            await prisma.riskAlert.findUnique({
                where: { id },
                select: { id: true, userId: true, assignedDoctorUserId: true, acknowledgedAt: true },
            }),
            "Alert not found"
        );

        await assertCanTriage(actor, alert);

        if (alert.acknowledgedAt) {
            throw badRequest("This alert has already been acknowledged");
        }

        // Claimed conditionally on `acknowledgedAt` still being null.
        //
        // The check above reads, and the write below used to be unconditional, so
        // two clinicians acknowledging the same disclosure at the same moment
        // both passed the check and both wrote. The row then names whichever
        // wrote last, while the audit log carries *two* `risk.acknowledged`
        // entries by two different people - so the trail and the record disagree
        // about who saw a crisis disclosure, which is the one question the
        // acknowledge timestamp exists to answer.
        const claimed = await prisma.riskAlert.updateMany({
            where: { id, acknowledgedAt: null },
            data: { acknowledgedAt: new Date(), acknowledgedById: actor.id },
        });
        if (claimed.count !== 1) {
            throw badRequest("This alert has already been acknowledged");
        }

        const updated = await prisma.riskAlert.findUniqueOrThrow({
            where: { id },
            select: { id: true, acknowledgedAt: true, acknowledgedById: true },
        });

        await AuditService.log({
            action: "risk.acknowledged",
            actorId: actor.id,
            targetType: "RiskAlert",
            targetId: id,
            meta: { userId: alert.userId },
        }).catch(() => undefined);

        return updated;
    }

    /**
     * Closes an alert with a note of what was actually done.
     *
     * The alert row is kept. "We raised this and dealt with it" is the record a
     * clinician needs when the same patient returns; deleting it would erase the
     * fact that a disclosure happened at all, which is the one thing that must
     * not be erasable.
     */
    static async resolve(
        actor: { id: number; role: string },
        id: number,
        note?: string | null
    ): Promise<{
        id: number;
        resolvedAt: Date | null;
        resolvedById: number | null;
        resolutionNote: string | null;
    }> {
        const alert = assertFound(
            await prisma.riskAlert.findUnique({
                where: { id },
                select: {
                    id: true,
                    userId: true,
                    assignedDoctorUserId: true,
                    acknowledgedAt: true,
                    resolvedAt: true,
                },
            }),
            "Alert not found"
        );

        await assertCanTriage(actor, alert);

        if (alert.resolvedAt) {
            throw badRequest("This alert has already been resolved");
        }

        // Resolving implies seeing. A clinician allowed to close something they
        // never opened is a gap in the audit trail, not a convenience - the
        // acknowledge timestamp is what tells a reviewer who actually looked.
        //
        // Claimed conditionally on `resolvedAt` still being null, for the same
        // reason as `acknowledge`: two resolvers both passed the check above and
        // both wrote, producing two audit entries and a row naming the last
        // writer. A disclosure has one resolver in the record or the record is
        // wrong.
        const now = new Date();
        const claimed = await prisma.riskAlert.updateMany({
            where: { id, resolvedAt: null },
            data: {
                resolvedAt: now,
                resolvedById: actor.id,
                ...(note ? { resolutionNote: note } : {}),
            },
        });
        if (claimed.count !== 1) {
            throw badRequest("This alert has already been resolved");
        }

        // "Resolving implies seeing" as a separate conditional write, so it fills
        // in the acknowledgement only if it is still empty and cannot overwrite a
        // clinician who acknowledged between the read above and this point.
        if (!alert.acknowledgedAt) {
            await prisma.riskAlert.updateMany({
                where: { id, acknowledgedAt: null },
                data: { acknowledgedAt: now, acknowledgedById: actor.id },
            });
        }

        const updated = await prisma.riskAlert.findUniqueOrThrow({
            where: { id },
            select: { id: true, resolvedAt: true, resolvedById: true, resolutionNote: true },
        });

        await AuditService.log({
            action: "risk.resolved",
            actorId: actor.id,
            targetType: "RiskAlert",
            targetId: id,
            // The note is recorded verbatim. It is clinical, it is authored by
            // the clinician who acted, and an audit trail that paraphrases it is
            // not an audit trail.
            meta: {
                userId: alert.userId,
                note: note ?? null,
                impliedAcknowledgement: !alert.acknowledgedAt,
            },
        }).catch(() => undefined);

        return updated;
    }
}

const assertCanTriage = async (
    actor: { id: number; role: string },
    alert: { userId: number; assignedDoctorUserId: number | null }
): Promise<void> => {
    if (actor.role === "admin") return;
    // An alert explicitly assigned to this clinician stays theirs even if the
    // clinical relationship has lapsed, for the same reason the queue keeps it.
    if (alert.assignedDoctorUserId === actor.id) return;
    if (await treatsPatient(actor.id, alert.userId)) return;
    throw forbidden("not your patient");
};
