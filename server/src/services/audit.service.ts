import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";



export interface AuditEntry {
    action: string;
    actorId?: number | null;
    targetType?: string | null;
    targetId?: number | null;
    meta?: Record<string, any> | null;
}

/**
 * A clinician *reading* another person's clinical record.
 *
 * ## Why this is separate from `AuditEntry`
 *
 * `AuditService.log` records writes and admin actions. Nothing recorded a
 * clinician opening a disclosure, a journal, a briefing or a care plan - so the
 * question "who looked at this patient's mental-health data, and when" could not
 * be answered at all. For a platform holding this data that is a real gap, and
 * it is the kind that is invisible until it is asked: writes were always
 * logged, so the absence of *read* records looked like there being nothing to
 * find.
 *
 * ## Why these fields are mandatory
 *
 * `subjectId` (whose record) and `subjectType` are separated from `actorId` and
 * `targetType` on purpose. `targetId` means "the thing acted upon", which for a
 * read is the row that was opened; `subjectId` is the *person whose data it
 * was*. Conflating them produces an audit trail that cannot answer its own
 * question: you cannot list every clinician who accessed one patient's record
 * without knowing which rows belong to that patient.
 */
export interface ReadAuditEntry {
    /** The clinician, or any authenticated actor, who opened the record. */
    actorId: number;
    /** Which kind of clinical record was read. */
    subjectType: ClinicalResource;
    /** Whose record it was - the patient, not the row id. */
    subjectId: number;
    /** The row that was opened, where the record has one. */
    targetId?: number | null;
    /** How it was reached: a route, a bulk list, an export. */
    via?: string | null;
    meta?: Record<string, any> | null;
}

/**
 * The clinical resources whose reads are recorded.
 *
 * A closed set rather than a free string, because a resource type that only
 * appears in the call site is a resource type nobody can enumerate - and
 * "enumerated" is the entire point of an access log.
 */
export const CLINICAL_RESOURCES = [
    "RiskAlert",
    "Message",
    "JournalEntry",
    "Assessment",
    "CarePlan",
    "SafetyPlan",
    "Briefing",
] as const;

export type ClinicalResource = (typeof CLINICAL_RESOURCES)[number];

export class AuditService {
    static async log(entry: AuditEntry) {
        try {
            await prisma.auditLog.create({
                data: {
                    action: entry.action,
                    actorId: entry.actorId ?? null,
                    targetType: entry.targetType ?? null,
                    targetId: entry.targetId ?? null,
                    meta: entry.meta ? JSON.stringify(entry.meta) : null,
                },
            });
        } catch (error) {
            console.error("[Audit] Failed to write audit log:", error);
        }
    }

    /**
     * Records that a clinician opened a clinical record.
     *
     * ## It never throws, and that is deliberate
     *
     * An audit write must not be able to deny care. If this rejected, a database
     * hiccup while logging a read would turn into a clinician unable to open a
     * patient's crisis disclosure - and the failure mode of an access log should
     * be "we lost a log line", never "a patient does not get help". So failures
     * are logged at `error` with enough context to find them, and the read
     * proceeds.
     *
     * The cost of that choice is real and belongs in the docs rather than in a
     * comment nobody reads: a sustained outage of the audit table produces a gap
     * in the access record, discoverable only from the error log. That is the
     * trade, and the error log is the compensating control.
     */
    static async logRead(entry: ReadAuditEntry): Promise<void> {
        try {
            await prisma.auditLog.create({
                data: {
                    action: "clinical.read",
                    actorId: entry.actorId,
                    targetType: entry.subjectType,
                    targetId: entry.targetId ?? null,
                    meta: JSON.stringify({
                        subjectId: entry.subjectId,
                        via: entry.via ?? null,
                        ...(entry.meta ?? {}),
                    }),
                },
            });
        } catch (error) {
            logger.error(
                {
                    err: (error as Error)?.message,
                    actorId: entry.actorId,
                    subjectType: entry.subjectType,
                    subjectId: entry.subjectId,
                },
                "audit: failed to record a clinical read - the access log has a gap"
            );
        }
    }

    /**
     * Every recorded read of one patient's record.
     *
     * This is the question the absence of read logging made unanswerable. Backs
     * the admin view; not exposed to patients, because "a clinician looked at
     * your disclosure" is not the patient's record to see - it is an internal
     * accountability artefact, and surfacing it would tell a clinician they are
     * being watched without telling anyone who.
     */
    static async readsForSubject(subjectId: number, limit = 100) {
        const entries = await prisma.auditLog.findMany({
            where: {
                action: "clinical.read",
                // The subject id lives inside `meta` because `AuditLog` predates
                // read logging and has no column for it.
                meta: { contains: `"subjectId":${subjectId}` },
            },
            include: { actor: { select: { id: true, name: true, role: true } } },
            orderBy: { createdAt: "desc" },
            take: Math.min(Math.max(limit, 1), 500),
        });
        return entries;
    }

    static async getLogs(page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [logs, total] = await Promise.all([
            prisma.auditLog.findMany({
                include: { actor: { select: { id: true, name: true, email: true, role: true } } },
                orderBy: { createdAt: "desc" },
                skip,
                take: limit,
            }),
            prisma.auditLog.count(),
        ]);
        return { logs, total, page, limit, totalPages: Math.ceil(total / limit) };
    }
}
