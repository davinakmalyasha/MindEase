import { Request, Response } from "express";
import { CarePlanService, SafetyPlanService } from "../services/carePlan.service";
import { badRequest, publicMessageFor } from "../utils/appError";

/**
 * Care plans and safety plans.
 *
 * Every handler funnels through `publicMessageFor`. The ownership rules live in
 * the service, where they cannot be forgotten by a route that forgets a
 * middleware.
 */
const handle = (fn: (req: Request) => Promise<unknown>, fallback: string) =>
    async (req: Request, res: Response) => {
        try {
            const data = await fn(req);
            res.json({ status: "success", data });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: fallback, status: 500 };
            res.status(status).json({ status: "error", message });
        }
    };

export class CarePlanController {
    /** The patient's own active plan. Created on first read. */
    static getMine = handle((req) => CarePlanService.getForPatient(req.user!.id), "Failed to load your care plan.");

    /** Every plan, closed ones included. */
    static list = handle((req) => CarePlanService.listForPatient(req.user!.id), "Failed to load your care plans.");

    static update = handle(
        async (req) => {
            const { title, summary, status, reviewAt } = req.body ?? {};
            return CarePlanService.updatePlan(req.user!.id, parseInt(req.params.id as string), {
                title,
                summary,
                status,
                reviewAt,
            });
        },
        "Failed to update the care plan."
    );

    static addGoal = handle(
        async (req) => {
            const { title, detail, targetDate } = req.body ?? {};
            return CarePlanService.addGoal(req.user!, parseInt(req.params.id as string), {
                title,
                detail,
                targetDate,
            });
        },
        "Failed to add the goal."
    );

    static updateGoal = handle(
        async (req) => {
            const { title, detail, status, targetDate } = req.body ?? {};
            return CarePlanService.updateGoal(req.user!, parseInt(req.params.id as string), {
                title,
                detail,
                status,
                targetDate,
            });
        },
        "Failed to update the goal."
    );

    static deleteGoal = handle(
        (req) => CarePlanService.deleteGoal(req.user!, parseInt(req.params.id as string)),
        "Failed to delete the goal."
    );

    static addStep = handle(
        async (req) => CarePlanService.addStep(req.user!, parseInt(req.params.id as string), req.body?.title),
        "Failed to add the step."
    );

    /**
     * Toggle rather than set, because completing a step is one tap and asking a
     * patient to choose between two endpoints for one tap is how a feature goes
     * unused.
     */
    static setStepDone = handle(
        (req) => {
            const done = req.body?.done;
            if (typeof done !== "boolean") throw badRequest("done must be a boolean");
            return CarePlanService.setStepDone(req.user!, parseInt(req.params.id as string), done);
        },
        "Failed to update the step."
    );

    /**
     * A clinician reading a patient's care plan.
     *
     * The mirror of the safety plan's clinician read, and it closes a real gap
     * rather than a cosmetic one: `assertMayContribute` deliberately lets a
     * treating clinician add goals and steps to a patient's plan, so before this
     * route existed a clinician could write into a document they had no way to
     * read back. Any client that will show the goals they just agreed needs it.
     */
    static getPlanForPatient = handle(
        (req) => CarePlanService.listForPatient(parseInt(req.params.id as string), req.user!),
        "Failed to load the patient's care plan."
    );
}

export class SafetyPlanController {
    static getMine = handle((req) => SafetyPlanService.get(req.user!, req.user!.id), "Failed to load your safety plan.");

    static saveMine = handle(
        (req) => SafetyPlanService.save(req.user!, req.user!.id, req.body ?? {}),
        "Failed to save your safety plan."
    );

    /**
     * A clinician reading a patient's plan. Separate from `getMine` so the
     * access check is visible at the route rather than implied by a query
     * parameter that could be set to anyone's id.
     */
    static getForPatient = handle(
        (req) => SafetyPlanService.get(req.user!, parseInt(req.params.id as string)),
        "Failed to load the safety plan."
    );

    static markReviewed = handle(
        (req) => SafetyPlanService.markReviewed(req.user!, parseInt(req.params.id as string)),
        "Failed to record the review."
    );
}
