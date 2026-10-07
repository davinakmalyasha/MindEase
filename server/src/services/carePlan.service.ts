/**
 * Longitudinal care plans and patient-owned safety plans.
 *
 * Two documents, two very different ownership models, in one service because
 * they answer the same question from opposite ends: what was agreed, and what
 * to do if it gets worse.
 *
 * Both are written by people. Neither is ever generated - see the schema
 * comments for why a model has no standing to author either.
 */
import { prisma } from "../lib/prisma";
import type { Prisma } from "@prisma/client";
import { assertFound, badRequest, conflict, forbidden } from "../utils/appError";
import { AuditService } from "./audit.service";
import { sanitize } from "../utils/sanitize";

const GOAL_STATUSES = ["open", "in_progress", "achieved", "paused", "dropped"] as const;
const PLAN_STATUSES = ["active", "completed", "paused"] as const;

type GoalStatus = (typeof GOAL_STATUSES)[number];
type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * The clinician is only ever a participant in a plan the patient owns.
 *
 * Both helpers answer "may this actor see this patient's clinical documents",
 * and both use the same rule the risk queue uses: a confirmed or completed
 * appointment. An admin is deliberately *not* given blanket access - an
 * administrator's job here is platform operations, and a patient's safety plan
 * is not operational data. Admin access to risk alerts is defensible because
 * those are triage items that may have no clinician attached; a safety plan
 * always belongs to a person and their clinician.
 */
const treats = async (doctorUserId: number, patientId: number): Promise<boolean> => {
    const row = await prisma.appointment.findFirst({
        where: { userId: patientId, status: { in: ["confirmed", "completed"] }, doctor: { userId: doctorUserId } },
        select: { id: true },
    });
    return row !== null;
};

/**
 * Goals ordered, with their steps ordered.
 *
 * Typed as `Prisma.CarePlanInclude` rather than `as const`: `as const` makes
 * the orderBy tuples readonly, which Prisma's generated types reject. The type
 * is also what keeps the include honest if the schema changes.
 */
const withPlanInclude = {
    goals: {
        orderBy: [{ order: "asc" }, { id: "asc" }],
        include: { steps: { orderBy: [{ order: "asc" }, { id: "asc" }] } },
    },
} satisfies Prisma.CarePlanInclude;

export class CarePlanService {
    /**
     * The patient's active plan, with its goals and steps.
     *
     * Auto-creates on first read. A patient returning after three weeks and
     * landing on an empty state is the exact failure this feature exists to
     * remove, so the empty state is a plan with no goals in it rather than
     * nothing at all.
     */
    static async getForPatient(patientId: number) {
        const existing = await prisma.carePlan.findFirst({
            where: { userId: patientId, status: "active" },
            orderBy: { createdAt: "desc" },
            include: withPlanInclude,
        });
        if (existing) return existing;

        return prisma.carePlan.create({
            data: { userId: patientId },
            include: withPlanInclude,
        });
    }

    /**
     * Every plan for a patient, closed ones included. The history is the point.
     *
     * Takes the actor when a clinician is reading somebody else's plan, and goes
     * through `assertMayContribute` in that case. A patient's own call passes no
     * actor and skips the check, because the id is `req.user.id` and there is
     * nothing to check.
     */
    static async listForPatient(patientId: number, actor?: { id: number; role: string }) {
        // A clinician reading somebody else's plan must have a live clinical
        // relationship. Without this route the only way a clinician could see a
        // plan at all was to know the patient's id and no endpoint to ask with.
        if (actor && actor.id !== patientId) {
            await assertMayContribute(actor, patientId);

            // A clinician opening somebody else's plan. Recorded here rather
            // than at the controller, because this service method is also
            // reachable from the patient's own `GET /care-plan` - and an access
            // log that fires for a patient reading their own document is noise
            // that trains people to ignore the log.
            await AuditService.logRead({
                actorId: actor.id,
                subjectType: "CarePlan",
                subjectId: patientId,
                via: "GET /api/care-plan/patient/:id",
            });
        }

        return prisma.carePlan.findMany({
            where: { userId: patientId },
            orderBy: { createdAt: "desc" },
            // Bounded, and a three-level eager load is not free. A patient has a
            // handful of plans; a hundred would be a bug elsewhere.
            take: 20,
            include: withPlanInclude,
        });
    }

    static async updatePlan(
        actorId: number,
        planId: number,
        patch: {
            title?: string;
            summary?: string | null;
            status?: PlanStatus;
            reviewAt?: string | null;
            /**
             * The version the caller was shown. Required.
             *
             * Optional would mean a client that had not been updated still
             * writes, which is the silent overwrite this exists to stop - the
             * guard would apply or not depending on the shape of the request
             * rather than on what happened to the data.
             */
            version: number;
        }
    ) {
        const plan = assertFound(
            await prisma.carePlan.findUnique({
                where: { id: planId },
                select: { id: true, userId: true, version: true },
            }),
            "Care plan not found"
        );
        // Patient-owned: only the owner edits it. A clinician contributes goals
        // (addGoal) rather than rewriting the patient's document.
        if (plan.userId !== actorId) throw forbidden("not your care plan");

        if (patch.status && !PLAN_STATUSES.includes(patch.status)) {
            throw badRequest("Invalid plan status");
        }

        // Conditional on the version the caller saw. Two concurrent saves cannot
        // both match: the UPDATE takes `version: { increment: 1 }` and matches
        // only the row still at the version that was read, so the loser's
        // `updateMany` returns zero rows and it is told to re-read.
        const written = await prisma.carePlan.updateMany({
            where: { id: planId, version: patch.version },
            data: {
                ...(patch.title !== undefined ? { title: patch.title.slice(0, 160) } : {}),
                ...(patch.summary !== undefined ? { summary: sanitize(patch.summary) } : {}),
                ...(patch.status !== undefined
                    ? {
                          status: patch.status,
                          // Closing a plan stamps closedAt. Left to the application
                          // rather than derived, because "completed" and
                          // "abandoned" are both terminal and the reason is in
                          // the summary the patient wrote.
                          ...(patch.status === "active" ? {} : { closedAt: new Date() }),
                      }
                    : {}),
                ...(patch.reviewAt !== undefined
                    ? { reviewAt: patch.reviewAt ? new Date(patch.reviewAt) : null }
                    : {}),
                version: { increment: 1 },
            },
        });

        if (written.count !== 1) {
            // The write did not happen. Reporting it as a conflict rather than
            // silently succeeding is the entire point: the alternative was a lost
            // edit with a success message on it.
            throw conflict(
                "This care plan was changed by someone else while you were editing. Reload to see their version."
            );
        }

        const updated = await prisma.carePlan.findUniqueOrThrow({
            where: { id: planId },
            include: withPlanInclude,
        });

        await AuditService.log({
            action: "careplan.updated",
            actorId,
            targetType: "CarePlan",
            targetId: planId,
        }).catch(() => undefined);

        return updated;
    }

    /**
     * Adds a goal.
     *
     * Callable by the patient or by their clinician. That is the one place a
     * clinician writes into the document, and it is additive on purpose: what
     * gets agreed in a session is a goal the patient can see, edit, complete or
     * drop themselves.
     */
    static async addGoal(
        actor: { id: number; role: string },
        planId: number,
        input: { title: string; detail?: string | null; targetDate?: string | null }
    ) {
        const plan = assertFound(
            await prisma.carePlan.findUnique({ where: { id: planId }, select: { id: true, userId: true } }),
            "Care plan not found"
        );
        await assertMayContribute(actor, plan.userId);

        const last = await prisma.careGoal.findFirst({
            where: { carePlanId: planId },
            orderBy: { order: "desc" },
            select: { order: true },
        });

        const goal = await prisma.careGoal.create({
            data: {
                carePlanId: planId,
                title: input.title.slice(0, 200),
                detail: input.detail ? sanitize(input.detail) : null,
                targetDate: input.targetDate ? new Date(input.targetDate) : null,
                order: (last?.order ?? -1) + 1,
            },
        });

        // When a clinician contributes, the plan is theirs to help carry.
        if (actor.role === "doctor" && plan.userId !== actor.id) {
            await prisma.carePlan
                .update({ where: { id: planId }, data: { doctorUserId: actor.id } })
                .catch(() => undefined);
        }

        await AuditService.log({
            action: "careplan.goal_added",
            actorId: actor.id,
            targetType: "CareGoal",
            targetId: goal.id,
            meta: { carePlanId: planId, patientId: plan.userId },
        }).catch(() => undefined);

        return goal;
    }

    static async updateGoal(
        actor: { id: number; role: string },
        goalId: number,
        patch: { title?: string; detail?: string | null; status?: GoalStatus; targetDate?: string | null }
    ) {
        const goal = assertFound(
            await prisma.careGoal.findUnique({
                where: { id: goalId },
                select: { id: true, carePlan: { select: { id: true, userId: true } } },
            }),
            "Goal not found"
        );
        await assertMayContribute(actor, goal.carePlan.userId);

        if (patch.status && !GOAL_STATUSES.includes(patch.status)) {
            throw badRequest("Invalid goal status");
        }

        return prisma.careGoal.update({
            where: { id: goalId },
            data: {
                ...(patch.title !== undefined ? { title: patch.title.slice(0, 200) } : {}),
                ...(patch.detail !== undefined ? { detail: patch.detail ? sanitize(patch.detail) : null } : {}),
                ...(patch.status !== undefined ? { status: patch.status } : {}),
                ...(patch.targetDate !== undefined
                    ? { targetDate: patch.targetDate ? new Date(patch.targetDate) : null }
                    : {}),
            },
        });
    }

    static async addStep(actor: { id: number; role: string }, goalId: number, title: string) {
        const goal = assertFound(
            await prisma.careGoal.findUnique({
                where: { id: goalId },
                select: { id: true, carePlan: { select: { userId: true } } },
            }),
            "Goal not found"
        );
        await assertMayContribute(actor, goal.carePlan.userId);

        const last = await prisma.careStep.findFirst({
            where: { careGoalId: goalId },
            orderBy: { order: "desc" },
            select: { order: true },
        });

        return prisma.careStep.create({
            data: { careGoalId: goalId, title: title.slice(0, 200), order: (last?.order ?? -1) + 1 },
        });
    }

    /**
     * Toggling a step is the most frequent action in the whole feature, so it
     * is a single call rather than set/unset endpoints.
     *
     * `doneAt` is maintained alongside `done` rather than derived, because "when
     * did they actually do this" is the clinically interesting question and a
     * boolean cannot answer it after the fact.
     */
    static async setStepDone(actor: { id: number; role: string }, stepId: number, done: boolean) {
        const step = assertFound(
            await prisma.careStep.findUnique({
                where: { id: stepId },
                select: { id: true, careGoal: { select: { carePlan: { select: { userId: true } } } } },
            }),
            "Step not found"
        );
        await assertMayContribute(actor, step.careGoal.carePlan.userId);

        return prisma.careStep.update({
            where: { id: stepId },
            data: { done, doneAt: done ? new Date() : null },
        });
    }

    static async deleteGoal(actor: { id: number; role: string }, goalId: number) {
        const goal = assertFound(
            await prisma.careGoal.findUnique({
                where: { id: goalId },
                select: { id: true, carePlan: { select: { userId: true } } },
            }),
            "Goal not found"
        );
        await assertMayContribute(actor, goal.carePlan.userId);
        await prisma.careGoal.delete({ where: { id: goalId } });
    }
}

export class SafetyPlanService {
    /**
     * Reads a patient's safety plan.
     *
     * Returns null rather than an empty object when none exists. The client
     * distinguishes "not written yet" from "written and empty", because a
     * patient who has deliberately left the coping section blank should not be
     * prompted to fill it in the moment they open the page.
     */
    static async get(actor: { id: number; role: string }, patientId: number) {
        await assertMayRead(actor, patientId);

        // The safety plan is the most sensitive document in the product: the
        // things a person notices in themselves before a crisis, what has
        // actually helped, and their reasons to live. A clinician opening
        // someone else's is recorded; the patient opening their own is not,
        // because an access log that fires on self-service is a log people stop
        // reading.
        if (actor.id !== patientId) {
            await AuditService.logRead({
                actorId: actor.id,
                subjectType: "SafetyPlan",
                subjectId: patientId,
                via: "GET /api/safety-plan/patient/:id",
            });
        }

        return prisma.safetyPlan.findUnique({ where: { userId: patientId } });
    }

    /**
     * Creates or replaces the plan.
     *
     * `upsert` on `userId` rather than create-or-error: a patient editing their
     * plan repeatedly should not have to know whether this is their first save.
     *
     * ## Why this is a merge and not a replace
     *
     * The original built `data` by mapping every field through
     * `input.X ? sanitize(input.X) : null`, and used it as the `update` branch of
     * the upsert. Since every field in the schema is optional, a client saving
     * one section sent the other five as `null` and the update set them to `null`
     * — so editing the professional contact silently erased the warning signs,
     * the coping strategies and the reasons to live.
     *
     * That is data loss on the document a person may need at their worst moment,
     * and the schema makes it easy to trigger: any form that sends one field.
     * A field the caller did not mention is now left alone; a field explicitly
     * sent as an empty string is cleared, which is what "I have no contact here"
     * should mean.
     */
    static async save(
        actor: { id: number; role: string },
        patientId: number,
        input: SafetyPlanInput & { version?: number }
    ) {
        await assertMayRead(actor, patientId);

        // Read first, both to compare and because the upsert below needs to know
        // whether a row exists. `upsert` cannot express the conditional UPDATE
        // that makes the write atomic, so the version check and the write are
        // two statements and the check is repeated *inside* the update's `where`.
        //
        // Repeating it is the part that matters. Checking here and then updating
        // by `userId` alone would reintroduce the race this is here to close -
        // two writers can both pass a check performed before either writes.
        const existing = await prisma.safetyPlan.findUnique({
            where: { userId: patientId },
            select: { id: true, version: true },
        });

        // Creating is not a conflict. Only an *update against a stale version*
        // is, and there is nothing to be stale about on first save.
        const expected = input.version;
        if (existing && expected !== undefined && existing.version !== expected) {
            throw conflict(
                "This safety plan was changed by someone else while you were editing. Reload to see their version."
            );
        }

        const clean = (v: string | null | undefined, max?: number) => {
            if (v === undefined) return undefined;
            if (v === null) return null;
            const s = sanitize(v);
            return max ? s.slice(0, max) || null : s || null;
        };

        // Only the keys the caller actually sent. `undefined` means "not
        // mentioned" and Prisma omits it from the update entirely.
        const data: Record<string, unknown> = {};
        const warningSigns = clean(input.warningSigns);
        if (warningSigns !== undefined) data.warningSigns = warningSigns;
        const copingStrategies = clean(input.copingStrategies);
        if (copingStrategies !== undefined) data.copingStrategies = copingStrategies;
        const reasonsToLive = clean(input.reasonsToLive);
        if (reasonsToLive !== undefined) data.reasonsToLive = reasonsToLive;
        const contacts = clean(input.contacts);
        if (contacts !== undefined) data.contacts = contacts;
        const professionalContact = clean(input.professionalContact, 255);
        if (professionalContact !== undefined) data.professionalContact = professionalContact;
        const locationToBeSafe = clean(input.locationToBeSafe, 255);
        if (locationToBeSafe !== undefined) data.locationToBeSafe = locationToBeSafe;

        let plan: {
            id: number;
            userId: number;
            warningSigns: string | null;
            copingStrategies: string | null;
            reasonsToLive: string | null;
            contacts: string | null;
            professionalContact: string | null;
            locationToBeSafe: string | null;
            lastReviewedAt: Date | null;
            version: number;
            createdAt: Date;
            updatedAt: Date;
        };
        if (existing) {
            // Conditional on the version that was just read, so the write is
            // atomic against a concurrent save. `updateMany` rather than
            // `update` because Prisma's `update` takes a unique `where` and
            // cannot express "and the version still matches".
            //
            // `expected ?? existing.version` - a caller that sent no version
            // still gets a conditional write against the version we just read,
            // so it loses the race rather than winning it by omission.
            const result = await prisma.safetyPlan.updateMany({
                where: { id: existing.id, version: expected ?? existing.version },
                data: { ...data, version: { increment: 1 } },
            });
            if (result.count !== 1) {
                throw conflict(
                    "This safety plan was changed by someone else while you were editing. Reload to see their version."
                );
            }
            plan = await prisma.safetyPlan.findUniqueOrThrow({ where: { id: existing.id } });
        } else {
            plan = await prisma.safetyPlan.create({
                data: {
                    userId: patientId,
                    warningSigns: (warningSigns as string | null) ?? null,
                    copingStrategies: (copingStrategies as string | null) ?? null,
                    reasonsToLive: (reasonsToLive as string | null) ?? null,
                    contacts: (contacts as string | null) ?? null,
                    professionalContact: (professionalContact as string | null) ?? null,
                    locationToBeSafe: (locationToBeSafe as string | null) ?? null,
                },
            });
        }

        await AuditService.log({
            action: "safetyplan.saved",
            actorId: actor.id,
            targetType: "SafetyPlan",
            targetId: plan.id,
            meta: { patientId },
        }).catch(() => undefined);

        return plan;
    }

    /**
     * Records that a clinician reviewed the plan with the patient.
     *
     * Separate from saving on purpose. A safety plan written alone in a moment
     * of good intent is materially weaker than one gone through with somebody,
     * and the difference is exactly what this timestamp exists to show. A
     * clinician can therefore see at a glance whether they are looking at a
     * co-authored plan.
     */
    static async markReviewed(actor: { id: number; role: string }, patientId: number) {
        // Doctor only. This previously also accepted `role === "admin"`, which
        // was unreachable: the route is `requireDoctor`, so an admin got a 403
        // before reaching here, and even without that guard `assertMayRead` only
        // admits a doctor with a live clinical relationship. A permission that
        // no principal can exercise reads as a permission that exists.
        if (actor.role !== "doctor") {
            throw forbidden("only a clinician can record a review");
        }
        await assertMayRead(actor, patientId);

        const plan = assertFound(
            await prisma.safetyPlan.findUnique({ where: { userId: patientId } }),
            "This patient has not written a safety plan yet"
        );

        return prisma.safetyPlan.update({
            where: { id: plan.id },
            data: { lastReviewedAt: new Date() },
        });
    }
}

export interface SafetyPlanInput {
    warningSigns?: string | null;
    copingStrategies?: string | null;
    reasonsToLive?: string | null;
    contacts?: string | null;
    professionalContact?: string | null;
    locationToBeSafe?: string | null;
    /** The version the caller was shown; a mismatch is a 409. See `save`. */
    version?: number;
}

/** Owner, or a clinician with an active relationship. */
const assertMayContribute = async (actor: { id: number; role: string }, patientId: number) => {
    if (actor.id === patientId) return;
    if (actor.role === "doctor" && (await treats(actor.id, patientId))) return;
    throw forbidden("not your patient");
};

const assertMayRead = assertMayContribute;
