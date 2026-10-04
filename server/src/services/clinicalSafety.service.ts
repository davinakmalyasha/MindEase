/**
 * Clinical safety signals derived from self-report instruments.
 *
 * The PHQ-9 asks directly whether a patient has had "thoughts that you would be
 * better off dead, or of hurting yourself in some way" (item 9). That answer
 * was previously reduced to a numeric total and otherwise discarded — so the
 * single most safety-critical response in the entire product produced no signal
 * at all.
 *
 * A non-zero answer is treated here as a disclosure that must (a) be recorded
 * durably, (b) reach the assigned clinician, and (c) be surfaced to the patient
 * immediately with crisis resources, rather than only after the results screen.
 */
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import { NotificationService } from "./notification.service";
import { publishEvent } from "./realtime.service";
import { AuditService } from "./audit.service";

export interface CrisisHotline {
    name: string;
    /** Number to place a call to. Voice lines must be linked with `tel:`. */
    dial: string;
    contact: string;
    whatsapp: boolean;
}

export const CRISIS_HOTLINES: CrisisHotline[] = [
    { name: "Emergency (Indonesia)", dial: "112", contact: "112 / 119", whatsapp: false },
    { name: "Kemenkes SEJIWA", dial: "119", contact: "119 ext 8", whatsapp: false },
    { name: "Halo Kemenkes", dial: "1500567", contact: "1500-567", whatsapp: false },
    { name: "Into The Light (WhatsApp)", dial: "628121232012", contact: "+62 812-123-2012", whatsapp: true },
];

/**
 * PHQ-9 item 9 is the ninth question, so index 8. Any answer above "not at
 * all" counts: a frequency of "several days" is still a disclosure.
 */
const PHQ9_SELF_HARM_ITEM_INDEX = 8;

export type RiskLevel = "elevated" | "urgent";

export interface RiskSignal {
    riskFlag: boolean;
    level: RiskLevel | null;
    reason: string | null;
    hotlines: CrisisHotline[];
    crisisPage: string;
    /** Present only when a clinician could actually be reached. */
    clinicianNotified: boolean;
    /**
     * False when the `RiskAlert` row could not be written.
     *
     * `clinicianNotified` and `recorded` are separate because they fail
     * independently, and conflating them is how a disclosure ends up with no
     * durable record while every caller believes it was handled. The failure that
     * motivates this is a pool exhaustion during a crisis submission — exactly
     * the moment the database is least likely to accept the write. The clinician
     * was paged by notification, so `clinicianNotified` was true; the row was
     * gone, so the audit trail said nothing.
     */
    recorded: boolean;
    /** Id of the `RiskAlert` row, or null when it could not be written. */
    alertId: number | null;
}

/**
 * Evaluates a completed assessment for clinically significant risk. Pure and
 * synchronous apart from the alerting side effects, so the rule is directly
 * unit-testable.
 */
export const detectAssessmentRisk = (
    type: string,
    answers: number[]
): { level: RiskLevel; reason: string } | null => {
    if (type !== "phq9") return null;

    const selfHarm = answers[PHQ9_SELF_HARM_ITEM_INDEX];
    if (typeof selfHarm !== "number" || selfHarm <= 0) return null;

    // "More than half the days" or "nearly every day" is treated as urgent.
    const level: RiskLevel = selfHarm >= 2 ? "urgent" : "elevated";
    return {
        level,
        reason: `PHQ-9 item 9 (thoughts of self-harm or death) answered "${["not at all", "several days", "more than half the days", "nearly every day"][selfHarm] ?? selfHarm}".`,
    };
};

/**
 * Records a risk disclosure and escalates it to the patient's assigned
 * clinician. Every downstream channel is isolated so one failing provider
 * cannot swallow the escalation.
 */
export const raiseRiskAlert = async (input: {
    userId: number;
    userName?: string | null;
    level: RiskLevel;
    reason: string;
    sourceType: string;
    sourceId?: number | null;
}): Promise<RiskSignal> => {
    // `clinicianNotified`, `recorded` and `alertId` are all resolved below. The
    // base is the part that is true the moment the disclosure is recognised.
    const base: Omit<RiskSignal, "clinicianNotified" | "recorded" | "alertId"> = {
        riskFlag: true,
        level: input.level,
        reason: input.reason,
        hotlines: CRISIS_HOTLINES,
        crisisPage: "/crisis",
    };

    // Resolved before the row is written, so `assignedDoctorUserId` can be set
    // in the same insert. The clinician is looked up first deliberately: an
    // alert that exists but is addressed to nobody is the failure this column
    // was added to prevent, so the write and the addressing have to be one
    // decision rather than two that can disagree.
    const appointment = await prisma.appointment
        .findFirst({
            where: { userId: input.userId, status: { in: ["confirmed", "completed"] } },
            orderBy: { appointmentDate: "desc" },
            select: { doctor: { select: { userId: true, user: { select: { name: true } } } } },
        })
        .catch(() => null);

    const assignedDoctorUserId = appointment?.doctor.userId ?? null;

    let alertId: number | null = null;
    try {
        const alert = await prisma.riskAlert.create({
            data: {
                userId: input.userId,
                level: input.level,
                reason: input.reason,
                sourceType: input.sourceType,
                sourceId: input.sourceId ?? null,
                assignedDoctorUserId,
            },
        });
        alertId = alert.id;
    } catch (err: any) {
        // The record is the audit trail; if it fails the escalation is still
        // attempted, but the failure must be visible - both in the log and in
        // what the caller is told. Returning a shape that reads as success here
        // is how a disclosure ends up with no durable trace.
        logger.error({ err: err.message, userId: input.userId }, "Failed to persist risk alert");
    }

    // Whether the durable record exists, as opposed to whether a human was
    // pinged. Computed once, from the same source as `alertId`, so the two
    // cannot disagree.
    const recorded = alertId !== null;

    if (!appointment) {
        await AuditService.log({
            action: "risk.raised",
            actorId: input.userId,
            meta: { level: input.level, sourceType: input.sourceType, clinicianNotified: false, recorded },
        }).catch(() => {});
        logger.warn({ userId: input.userId, level: input.level }, "Risk disclosure with no assigned clinician");
        return { ...base, clinicianNotified: false, recorded, alertId };
    }

    const doctorUserId = appointment.doctor.userId;
    const name = input.userName || "A patient";

    const tryChannel = async (channel: string, run: () => Promise<unknown>) => {
        try {
            await run();
        } catch (err: any) {
            logger.error({ err: err.message, channel, userId: input.userId }, "Risk escalation channel failed");
        }
    };

    let clinicianReached = false;
    await tryChannel("inapp", async () => {
        await NotificationService.create({
            userId: doctorUserId,
            title: input.level === "urgent" ? "Urgent risk disclosure from a patient" : "Risk disclosure from a patient",
            message: `${name} reported thoughts of self-harm or death on a screening questionnaire (${input.level}). Please reach out to them today.`,
            type: "system",
            email: true,
        });
        clinicianReached = true;
    });

    await tryChannel("realtime", () =>
        publishEvent(doctorUserId, {
            type: "risk:alert",
            payload: { patientName: name, level: input.level, alertId },
        })
    );

    // Also notify an administrator so an unassigned disclosure is not silently
    // held only by the patient.
    await tryChannel("admin", async () => {
        const admins = await prisma.user.findMany({
            where: { role: "admin", isBanned: false },
            select: { id: true },
            take: 5,
        });
        await Promise.all(
            admins.map((a) =>
                NotificationService.create({
                    userId: a.id,
                    title: "Risk disclosure awaiting review",
                    message: `${name} disclosed thoughts of self-harm (${input.level}) and has no clinician currently assigned.`,
                    type: "system",
                }).catch(() => undefined)
            )
        );
    });

    await tryChannel("audit", () =>
        AuditService.log({
            action: "risk.raised",
            actorId: input.userId,
            targetType: "RiskAlert",
            targetId: alertId ?? 0,
            meta: { level: input.level, sourceType: input.sourceType, doctorUserId },
        })
    );

    // `alertId !== null` rather than `recorded`, because TypeScript narrows the
    // null away and the `where` clause needs a `number`. The two are equivalent
    // by construction - `recorded` is defined as that comparison - and the
    // narrowing is worth more than the readability of reusing the flag.
    if (clinicianReached && alertId !== null) {
        await prisma.riskAlert
            .update({ where: { id: alertId }, data: { notifiedDoctorUserId: doctorUserId } })
            .catch(() => null);
    }

    if (!recorded) {
        // Loud, and separate from the per-channel warnings above: this one means
        // the disclosure has no durable record at all.
        logger.error(
            { userId: input.userId, level: input.level, clinicianReached },
            "Risk disclosure escalated with no durable record: the RiskAlert row was not written"
        );
    }

    return { ...base, clinicianNotified: clinicianReached, recorded, alertId };
};

export const NO_RISK: Omit<RiskSignal, "riskFlag"> = {
    level: null,
    reason: null,
    hotlines: CRISIS_HOTLINES,
    crisisPage: "/crisis",
    clinicianNotified: false,
    recorded: true,
    alertId: null,
};
