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
import { assertFound, badRequest, forbidden } from "../utils/appError";
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

    /** Every plan for a patient, closed ones included. The history is the point. */
    static async listForPatient(patientId: number) {
        return prisma.carePlan.findMany({
            where: { userId: patientId },
            orderBy: { createdAt: "desc" },
            include: withPlanInclude,
        });
    }

    static async updatePlan(
        actorId: number,
        planId: number,
        patch: { title?: string; summary?: string | null; status?: PlanStatus; reviewAt?: string | null }
    ) {
        const plan = assertFound(
            await prisma.carePlan.findUnique({ where: { id: planId }, select: { id: true, userId: true } }),
            "Care plan not found"
        );
        // Patient-owned: only the owner edits it. A clinician contributes goals
        // (addGoal) rather than rewriting the patient's document.
        if (plan.userId !== actorId) throw forbidden("not your care plan");

        if (patch.status && !PLAN_STATUSES.includes(patch.status)) {
            throw badRequest("Invalid plan status");
        }

        const updated = await prisma.carePlan.update({
            where: { id: planId },
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
            },
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
        return prisma.safetyPlan.findUnique({ where: { userId: patientId } });
    }

    /**
     * Creates or replaces the plan.
     *
     * `upsert` on `userId` rather than create-or-error: a patient editing their
     * plan repeatedly should not have to know whether this is their first save.
     */
    static async save(actor: { id: number; role: string }, patientId: number, input: SafetyPlanInput) {
        await assertMayRead(actor, patientId);

        const data = {
            warningSigns: input.warningSigns ? sanitize(input.warningSigns) : null,
            copingStrategies: input.copingStrategies ? sanitize(input.copingStrategies) : null,
            reasonsToLive: input.reasonsToLive ? sanitize(input.reasonsToLive) : null,
            contacts: input.contacts ? sanitize(input.contacts) : null,
            professionalContact: input.professionalContact
                ? input.professionalContact.slice(0, 255)
                : null,
            locationToBeSafe: input.locationToBeSafe ? input.locationToBeSafe.slice(0, 255) : null,
        };

        const plan = await prisma.safetyPlan.upsert({
            where: { userId: patientId },
            create: { userId: patientId, ...data },
            update: data,
        });

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
        if (actor.role !== "doctor" && actor.role !== "admin") {
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
}

/** Owner, or a clinician with an active relationship. */
const assertMayContribute = async (actor: { id: number; role: string }, patientId: number) => {
    if (actor.id === patientId) return;
    if (actor.role === "doctor" && (await treats(actor.id, patientId))) return;
    throw forbidden("not your patient");
};

const assertMayRead = assertMayContribute;
