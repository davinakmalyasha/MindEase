import { describe, it, expect } from "vitest";
import request from "supertest";
import { prisma } from "../src/app";
import { app, createUser, createDoctor, createAdmin } from "./helpers";

/**
 * Care plans and safety plans.
 *
 * Two documents with opposite ownership models, so almost every assertion here
 * is about *who may touch which patient's record* rather than about payload
 * shape. A care plan is patient-owned: a clinician may add a goal to it and
 * nothing else. A safety plan is patient-owned outright and additionally carries
 * a "a clinician went through this with them" timestamp that means nothing
 * unless it is unreachable by anyone else.
 *
 * The access rule is one helper (`assertMayContribute`) keyed off the plan's
 * owner, applied in the service rather than by route middleware. That is the
 * right place for it - a route that forgets a middleware cannot forget it - and
 * it is also the kind of thing that silently stops working if one of the
 * lookups it depends on stops finding the owner. So the ownership cases below go
 * through every route that can reach that helper, and assert on HTTP status and
 * on the database rather than on the code path taken.
 */

/**
 * Puts a clinical relationship in place.
 *
 * Both relations are connected rather than given as bare scalar ids. Prisma
 * rejects a `data` object that mixes the checked and unchecked input forms:
 * passing `userId` alongside `doctor: { connect }` makes the write ambiguous
 * and it throws "Argument `user` is missing".
 */
const link = (patientId: number, doctorUserId: number, status: string) =>
    prisma.appointment.create({
        data: {
            user: { connect: { id: patientId } },
            doctor: { connect: { userId: doctorUserId } },
            appointmentDate: new Date(),
            startTime: "10:00",
            endTime: "11:00",
            status,
            consultationType: "video",
        },
    });

/** Seeds a plan the way the service would, so ownership has something to key off. */
const seedPlan = (userId: number, title = "My care plan") =>
    prisma.carePlan.create({ data: { userId, title } });

const seedGoal = (carePlanId: number, title: string, status = "open") =>
    prisma.careGoal.create({ data: { carePlanId, title, status } });

const seedStep = (careGoalId: number, title: string) =>
    prisma.careStep.create({ data: { careGoalId, title } });

/**
 * A patient with a safety plan already written, for the clinician-facing cases.
 *
 * Returned as the row as well as the patient so a test can assert against the
 * id the upsert reused.
 */
const writeSafetyPlan = (userId: number) => {
    // A direct write rather than a call through the patient's own save path, so
    // the clinician-facing cases depend only on the clinician-facing rules.
    return prisma.safetyPlan.create({
        data: {
            userId,
            warningSigns: "Not answering messages, sleeping through the day.",
            copingStrategies: "Walk to the corner shop. Text my sister.",
            reasonsToLive: "I want to see my nephew grow up.",
            contacts: JSON.stringify([{ name: "Rani", phone: "+628111", relationship: "sister" }]),
            professionalContact: "Dr Akmal, +628222",
            locationToBeSafe: "Mum's house. Photo of the dog on my phone.",
        },
    });
};

/** A CSRF-protected request with a CSRF pair but no session, i.e. anonymous. */
const anonymousPost = async (path: string) => {
    const bootstrap = await request(app).get("/api/csrf-token");
    const cookies = bootstrap.headers["set-cookie"];
    const jar = (Array.isArray(cookies) ? cookies : [])
        .map((c) => c.split(";")[0])
        .join("; ");
    return request(app)
        .post(path)
        .set("X-CSRF-Token", bootstrap.body.data.csrfToken)
        .set("Cookie", jar);
};

// ---------------------------------------------------------------------------

describe("care plan ownership", () => {
    it("gives the patient their own plan back on first read", async () => {
        const patient = await createUser("patient");

        const res = await patient.agent.get("/api/care-plan");

        expect(res.status).toBe(200);
        expect(res.body.data.userId).toBe(patient.id);
    });

    it("creates the plan once, not a fresh one on every read", async () => {
        // A patient opening the page twice in a row must not end up with two
        // active plans and no way to tell which one the goals were added to.
        const patient = await createUser("patient");

        const first = await patient.agent.get("/api/care-plan");
        const second = await patient.agent.get("/api/care-plan");

        expect(second.body.data.id).toBe(first.body.data.id);
        expect(await prisma.carePlan.count({ where: { userId: patient.id } })).toBe(1);
    });

    it("lets the patient write their own plan", async () => {
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);

        const res = await patient.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ title: "Feeling better by spring", summary: "Sleeping through the night again." });

        expect(res.status).toBe(200);
        const stored = await prisma.carePlan.findUnique({ where: { id: plan.id } });
        expect(stored?.title).toBe("Feeling better by spring");
        expect(stored?.summary).toBe("Sleeping through the night again.");
    });

    it("lets a clinician with a confirmed appointment add a goal", async () => {
        // Contributing a goal is the one thing a clinician does inside someone
        // else's document: what gets agreed in a session is a goal the patient
        // can then see and complete themselves.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await link(patient.id, doctor.id, "confirmed");
        const plan = await seedPlan(patient.id);

        const res = await doctor.agent
            .post(`/api/care-plan/${plan.id}/goals`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ title: "Keep a sleep diary", detail: "Two weeks, every morning." });

        expect(res.status).toBe(200);
        const goal = await prisma.careGoal.findFirst({ where: { carePlanId: plan.id } });
        expect(goal?.title).toBe("Keep a sleep diary");
    });

    it("treats a completed appointment as a live relationship", async () => {
        // Post-discharge follow-up is the case this guards. A clinician whose
        // only session is over is exactly the person who needs to keep writing
        // into the plan, and `completed` sits next to `confirmed` on purpose.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await link(patient.id, doctor.id, "completed");
        const plan = await seedPlan(patient.id);

        const res = await doctor.agent
            .post(`/api/care-plan/${plan.id}/goals`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ title: "Book the follow-up before March" });

        expect(res.status).toBe(200);
    });

    it("refuses a clinician with no relationship to the patient", async () => {
        // A clinician who has never seen the patient writing goals into their
        // plan is a stranger with write access to a clinical document.
        const patient = await createUser("patient");
        const stranger = await createDoctor();
        const plan = await seedPlan(patient.id);

        const res = await stranger.agent
            .post(`/api/care-plan/${plan.id}/goals`)
            .set("X-CSRF-Token", stranger.csrf)
            .send({ title: "Something I made up" });

        expect(res.status).toBe(403);
        expect(await prisma.careGoal.count({ where: { carePlanId: plan.id } })).toBe(0);
    });

    it("refuses a clinician whose appointment was cancelled", async () => {
        // Cancelled is what a patient cancelling actually does, so it is the
        // realistic way a relationship lapses. Access has to end with it.
        const patient = await createUser("patient");
        const former = await createDoctor();
        await link(patient.id, former.id, "cancelled");
        const plan = await seedPlan(patient.id);

        const res = await former.agent
            .post(`/api/care-plan/${plan.id}/goals`)
            .set("X-CSRF-Token", former.csrf)
            .send({ title: "Still got to be able to do this" });

        expect(res.status).toBe(403);
    });

    it("does not let a clinician rewrite the patient's document", async () => {
        // The plan is patient-owned. A clinician contributes a goal; they do not
        // rewrite the summary, or close the plan, or replace its title.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await link(patient.id, doctor.id, "confirmed");
        const plan = await seedPlan(patient.id);

        const res = await doctor.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ summary: "Patient is doing well, prognosis good." });

        expect(res.status).toBe(403);
        const stored = await prisma.carePlan.findUnique({ where: { id: plan.id } });
        expect(stored?.summary).toBeNull();
    });

    it("refuses a patient writing into another patient's plan", async () => {
        const owner = await createUser("patient");
        const other = await createUser("patient");
        const plan = await seedPlan(owner.id);

        const res = await other.agent
            .post(`/api/care-plan/${plan.id}/goals`)
            .set("X-CSRF-Token", other.csrf)
            .send({ title: "Not my goal" });

        expect(res.status).toBe(403);
        expect(await prisma.careGoal.count({ where: { carePlanId: plan.id } })).toBe(0);
    });

    it("refuses a patient editing another patient's plan", async () => {
        const owner = await createUser("patient");
        const other = await createUser("patient");
        const plan = await seedPlan(owner.id);

        const res = await other.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", other.csrf)
            .send({ title: "Rewritten" });

        expect(res.status).toBe(403);
        const stored = await prisma.carePlan.findUnique({ where: { id: plan.id } });
        expect(stored?.title).toBe("My care plan");
    });

    it("refuses a patient updating a goal from another patient's plan", async () => {
        // The goal id is all the route carries, so the ownership check has to be
        // resolved through goal -> plan -> owner rather than trusted from the
        // request. A missed join here is a write into a stranger's plan.
        const owner = await createUser("patient");
        const other = await createUser("patient");
        const plan = await seedPlan(owner.id);
        const goal = await seedGoal(plan.id, "Attend the support group");

        const res = await other.agent
            .put(`/api/care-plan/goals/${goal.id}`)
            .set("X-CSRF-Token", other.csrf)
            .send({ status: "achieved" });

        expect(res.status).toBe(403);
        const stored = await prisma.careGoal.findUnique({ where: { id: goal.id } });
        expect(stored?.status).toBe("open");
    });

    it("refuses a patient adding a step to another patient's goal", async () => {
        const owner = await createUser("patient");
        const other = await createUser("patient");
        const plan = await seedPlan(owner.id);
        const goal = await seedGoal(plan.id, "Sleep hygiene");

        const res = await other.agent
            .post(`/api/care-plan/goals/${goal.id}/steps`)
            .set("X-CSRF-Token", other.csrf)
            .send({ title: "Screens off by ten" });

        expect(res.status).toBe(403);
        expect(await prisma.careStep.count({ where: { careGoalId: goal.id } })).toBe(0);
    });

    it("refuses a patient toggling a step in another patient's plan", async () => {
        const owner = await createUser("patient");
        const other = await createUser("patient");
        const plan = await seedPlan(owner.id);
        const goal = await seedGoal(plan.id, "Walk more");
        const step = await seedStep(goal.id, "Twenty minutes a day");

        const res = await other.agent
            .patch(`/api/care-plan/steps/${step.id}`)
            .set("X-CSRF-Token", other.csrf)
            .send({ done: true });

        expect(res.status).toBe(403);
        const stored = await prisma.careStep.findUnique({ where: { id: step.id } });
        expect(stored?.done).toBe(false);
        expect(stored?.doneAt).toBeNull();
    });

    it("refuses a patient deleting a goal from another patient's plan", async () => {
        const owner = await createUser("patient");
        const other = await createUser("patient");
        const plan = await seedPlan(owner.id);
        const goal = await seedGoal(plan.id, "Keep going");

        const res = await other.agent
            .delete(`/api/care-plan/goals/${goal.id}`)
            .set("X-CSRF-Token", other.csrf);

        expect(res.status).toBe(403);
        expect(await prisma.careGoal.count({ where: { id: goal.id } })).toBe(1);
    });

    it("keeps another patient's plan out of the history list", async () => {
        // `listForPatient` is scoped to the caller. If it ever widened, every
        // patient's plan history would be enumerable from the endpoint that has
        // no `:id` in it to get wrong.
        const owner = await createUser("patient");
        const other = await createUser("patient");
        const mine = await seedPlan(owner.id, "Mine");
        const theirs = await seedPlan(other.id, "Theirs");

        const res = await other.agent.get("/api/care-plan/all");

        expect(res.status).toBe(200);
        expect(res.body.data.map((p: { id: number }) => p.id)).toEqual([theirs.id]);
        expect(res.body.data.map((p: { id: number }) => p.id)).not.toContain(mine.id);
    });

    it("404s a goal that does not exist", async () => {
        // An unknown id must not be reported as a permission failure, or a
        // caller cannot tell "not yours" from "never existed".
        const patient = await createUser("patient");

        const res = await patient.agent
            .put("/api/care-plan/goals/99999999")
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "achieved" });

        expect(res.status).toBe(404);
    });

    it("404s a plan that does not exist", async () => {
        const patient = await createUser("patient");

        const res = await patient.agent
            .post("/api/care-plan/99999999/goals")
            .set("X-CSRF-Token", patient.csrf)
            .send({ title: "Into the void" });

        expect(res.status).toBe(404);
    });
});

// ---------------------------------------------------------------------------

describe("care plan and safety plan role gates", () => {
    it("rejects an anonymous caller with 401 on the patient's own plan", async () => {
        const res = await request(app).get("/api/care-plan");
        expect(res.status).toBe(401);
    });

    it("rejects an anonymous caller with 401, not 403, on the doctor-only read", async () => {
        // 403 would tell an unauthenticated caller "this exists and you are the
        // wrong kind of caller". 401 is the honest answer, and it is the branch
        // that is easy to lose if the role gate is ever mounted ahead of
        // authentication.
        const res = await request(app).get("/api/safety-plan/patient/1");

        expect(res.status).toBe(401);
        expect(res.body.message).not.toMatch(/doctor/i);
    });

    it("rejects an anonymous caller with 401 on the doctor-only write", async () => {
        // Carries a valid CSRF pair so the request gets past the CSRF guard and
        // actually exercises the auth chain, rather than being turned away by a
        // 403 that proves nothing about the role gate.
        const res = await anonymousPost("/api/safety-plan/patient/1/reviewed");
        expect(res.status).toBe(401);
    });

    it("rejects an anonymous caller with 401 on a care plan write", async () => {
        const res = await anonymousPost("/api/care-plan/1/goals");
        expect(res.status).toBe(401);
    });

    it("rejects a patient on the doctor-only safety plan read", async () => {
        const patient = await createUser("patient");
        await writeSafetyPlan(patient.id);

        const res = await patient.agent.get(`/api/safety-plan/patient/${patient.id}`);

        expect(res.status).toBe(403);
    });

    it("rejects a patient on the doctor-only review endpoint", async () => {
        // A patient must not be able to mark their own plan as clinically
        // reviewed. The timestamp exists to distinguish a co-authored plan from
        // one written alone in a moment of good intent, and a patient setting it
        // makes that distinction worthless.
        const patient = await createUser("patient");
        await writeSafetyPlan(patient.id);

        const res = await patient.agent
            .post(`/api/safety-plan/patient/${patient.id}/reviewed`)
            .set("X-CSRF-Token", patient.csrf);

        expect(res.status).toBe(403);
        const stored = await prisma.safetyPlan.findUnique({ where: { userId: patient.id } });
        expect(stored?.lastReviewedAt).toBeNull();
    });

    it("rejects an admin on the doctor-only safety plan read", async () => {
        // An administrator's job here is platform operations; a patient's safety
        // plan is not operational data. Documented on the service, and pinned
        // here because widening this is a one-character change to the gate.
        const patient = await createUser("patient");
        await writeSafetyPlan(patient.id);
        const admin = await createAdmin();

        const res = await admin.agent.get(`/api/safety-plan/patient/${patient.id}`);

        expect(res.status).toBe(403);
    });
});

// ---------------------------------------------------------------------------

describe("care plan goals", () => {
    it("creates a goal on the plan and returns it", async () => {
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);

        const res = await patient.agent
            .post(`/api/care-plan/${plan.id}/goals`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ title: "Walk the dog", detail: "Even on bad days.", targetDate: "2026-12-01" });

        // 200, not 201: the shared handler answers every route in this file
        // with `res.json`. Asserted explicitly so a client that branches on
        // 201 and a later change to the handler fail here rather than silently.
        expect(res.status).toBe(200);
        expect(res.body.data.title).toBe("Walk the dog");
        expect(res.body.data.carePlanId).toBe(plan.id);
    });

    it("sequences goals in the order they were added", async () => {
        // `order` is what the UI renders, so an unstable or reused order makes
        // a plan shuffle under the patient between visits.
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);

        for (const title of ["First", "Second", "Third"]) {
            const res = await patient.agent
                .post(`/api/care-plan/${plan.id}/goals`)
                .set("X-CSRF-Token", patient.csrf)
                .send({ title });
            expect(res.status).toBe(200);
        }

        const stored = await prisma.careGoal.findMany({
            where: { carePlanId: plan.id },
            orderBy: { order: "asc" },
        });
        expect(stored.map((g) => [g.order, g.title])).toEqual([
            [0, "First"],
            [1, "Second"],
            [2, "Third"],
        ]);

        const read = await patient.agent.get("/api/care-plan");
        expect(read.body.data.goals.map((g: { title: string }) => g.title)).toEqual([
            "First",
            "Second",
            "Third",
        ]);
    });

    it("updates the fields a patient actually edits", async () => {
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);
        const goal = await seedGoal(plan.id, "Journaling");

        const res = await patient.agent
            .put(`/api/care-plan/goals/${goal.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ title: "Journal every evening", status: "in_progress", targetDate: "2026-11-30" });

        expect(res.status).toBe(200);
        const stored = await prisma.careGoal.findUnique({ where: { id: goal.id } });
        expect(stored?.title).toBe("Journal every evening");
        expect(stored?.status).toBe("in_progress");
        expect(stored?.targetDate?.toISOString()).toContain("2026-11-30");
    });

    it("keeps `achieved` and `dropped` as distinct outcomes", async () => {
        // The whole reason both exist. A goal abandoned because it was wrong, or
        // because treatment changed, has to stay distinguishable from one that
        // was met - otherwise the plan reports more progress than happened.
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);
        const met = await seedGoal(plan.id, "Stopped drinking");
        const abandoned = await seedGoal(plan.id, "Learn to scuba dive");

        const doneRes = await patient.agent
            .put(`/api/care-plan/goals/${met.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "achieved" });
        const dropRes = await patient.agent
            .put(`/api/care-plan/goals/${abandoned.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "dropped" });

        expect(doneRes.status).toBe(200);
        expect(dropRes.status).toBe(200);

        const rows = await prisma.careGoal.findMany({ where: { carePlanId: plan.id } });
        expect(rows.find((r) => r.id === met.id)?.status).toBe("achieved");
        expect(rows.find((r) => r.id === abandoned.id)?.status).toBe("dropped");
    });

    it("does not quietly promote a dropped goal when it is re-read", async () => {
        // Guards the same distinction from the read side: the plan the patient
        // and their clinician both see has to agree with what was recorded.
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);
        const goal = await seedGoal(plan.id, "Run a half marathon");

        await patient.agent
            .put(`/api/care-plan/goals/${goal.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "dropped" });

        const res = await patient.agent.get("/api/care-plan");
        expect(res.body.data.goals[0].status).toBe("dropped");
    });

    it("can move a goal back into progress", async () => {
        // Real clinical work: a dropped goal is not always final. If the status
        // enum were write-once, a patient who picks a goal back up could not
        // record that it restarted.
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);
        const goal = await seedGoal(plan.id, "Swim again", "dropped");

        const res = await patient.agent
            .put(`/api/care-plan/goals/${goal.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "in_progress" });

        expect(res.status).toBe(200);
        const stored = await prisma.careGoal.findUnique({ where: { id: goal.id } });
        expect(stored?.status).toBe("in_progress");
    });

    it("refuses a goal status that is not in the enum", async () => {
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);
        const goal = await seedGoal(plan.id, "Anything");

        const res = await patient.agent
            .put(`/api/care-plan/goals/${goal.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "finished" });

        expect(res.status).toBe(400);
        const stored = await prisma.careGoal.findUnique({ where: { id: goal.id } });
        expect(stored?.status).toBe("open");
    });

    it("requires a goal title", async () => {
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);

        const res = await patient.agent
            .post(`/api/care-plan/${plan.id}/goals`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ detail: "No title though." });

        expect(res.status).toBe(400);
        expect(await prisma.careGoal.count({ where: { carePlanId: plan.id } })).toBe(0);
    });

    it("deletes a goal and takes its steps with it", async () => {
        // Steps are children of the goal, so a delete that left them behind
        // would make a reused goal id surface someone else's actions.
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);
        const goal = await seedGoal(plan.id, "Quit caffeine");
        const step = await seedStep(goal.id, "No coffee after noon");

        const res = await patient.agent
            .delete(`/api/care-plan/goals/${goal.id}`)
            .set("X-CSRF-Token", patient.csrf);

        expect(res.status).toBe(200);
        expect(await prisma.careGoal.count({ where: { id: goal.id } })).toBe(0);
        expect(await prisma.careStep.count({ where: { id: step.id } })).toBe(0);
    });

    it("leaves the plan readable after a goal is deleted", async () => {
        // Deleting a goal is a normal thing to do, not a reason for the patient
        // to hit a broken screen on their way out.
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);
        const goal = await seedGoal(plan.id, "Temporary");

        await patient.agent.delete(`/api/care-plan/goals/${goal.id}`).set("X-CSRF-Token", patient.csrf);

        const res = await patient.agent.get("/api/care-plan");
        expect(res.status).toBe(200);
        expect(res.body.data.goals).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------

describe("care plan steps", () => {
    it("adds a step to a goal in sequence", async () => {
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);
        const goal = await seedGoal(plan.id, "Sleep through the night");

        for (const title of ["Screens off by ten", "No caffeine after two"]) {
            const res = await patient.agent
                .post(`/api/care-plan/goals/${goal.id}/steps`)
                .set("X-CSRF-Token", patient.csrf)
                .send({ title });
            expect(res.status).toBe(200);
        }

        const stored = await prisma.careStep.findMany({
            where: { careGoalId: goal.id },
            orderBy: { order: "asc" },
        });
        expect(stored.map((s) => [s.order, s.title])).toEqual([
            [0, "Screens off by ten"],
            [1, "No caffeine after two"],
        ]);
    });

    it("returns steps nested under their goal", async () => {
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);
        const goal = await seedGoal(plan.id, "Eat properly");
        await seedStep(goal.id, "Breakfast every day");
        await seedStep(goal.id, "Cook on Sunday");

        const res = await patient.agent.get("/api/care-plan");

        expect(res.body.data.goals[0].steps.map((s: { title: string }) => s.title)).toEqual([
            "Breakfast every day",
            "Cook on Sunday",
        ]);
    });

    it("stamps doneAt when a step is ticked off", async () => {
        // `doneAt` is maintained next to the boolean rather than derived, because
        // "when did they actually do this" is the clinically interesting question
        // and a boolean cannot answer it after the fact.
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);
        const goal = await seedGoal(plan.id, "Take medication");
        const step = await seedStep(goal.id, "Morning dose");

        const before = new Date();
        const res = await patient.agent
            .patch(`/api/care-plan/steps/${step.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ done: true });

        expect(res.status).toBe(200);
        const stored = await prisma.careStep.findUnique({ where: { id: step.id } });
        expect(stored?.done).toBe(true);
        expect(stored?.doneAt).not.toBeNull();
        expect(stored!.doneAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    });

    it("clears doneAt when a step is unticked", async () => {
        // Someone who ticks the wrong box has to be able to undo it, and a
        // leftover timestamp would leave a completed action sitting in the
        // record for a step that is not done.
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);
        const goal = await seedGoal(plan.id, "Take medication");
        const step = await seedStep(goal.id, "Morning dose");

        await patient.agent
            .patch(`/api/care-plan/steps/${step.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ done: true });
        const res = await patient.agent
            .patch(`/api/care-plan/steps/${step.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ done: false });

        expect(res.status).toBe(200);
        const stored = await prisma.careStep.findUnique({ where: { id: step.id } });
        expect(stored?.done).toBe(false);
        expect(stored?.doneAt).toBeNull();
    });

    it("keeps a clinician's ticking of a patient's step inside that patient's plan", async () => {
        // A clinician marking steps during a session is a legitimate and common
        // action, so the write path has to allow it as well as the read.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await link(patient.id, doctor.id, "confirmed");
        const plan = await seedPlan(patient.id);
        const goal = await seedGoal(plan.id, "Practise grounding");
        const step = await seedStep(goal.id, "5-4-3-2-1 exercise");

        const res = await doctor.agent
            .patch(`/api/care-plan/steps/${step.id}`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ done: true });

        expect(res.status).toBe(200);
        const stored = await prisma.careStep.findUnique({ where: { id: step.id } });
        expect(stored?.done).toBe(true);
    });

    it("requires done to be a boolean", async () => {
        // The toggle is the most frequent action in the feature. A truthy string
        // silently becoming "done" would mean a client bug marks a patient's
        // steps complete without them ever having touched them.
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);
        const goal = await seedGoal(plan.id, "Take medication");
        const step = await seedStep(goal.id, "Morning dose");

        const res = await patient.agent
            .patch(`/api/care-plan/steps/${step.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ done: "yes" });

        expect(res.status).toBe(400);
        const stored = await prisma.careStep.findUnique({ where: { id: step.id } });
        expect(stored?.done).toBe(false);
    });

    it("404s a step that does not exist", async () => {
        const patient = await createUser("patient");
        const res = await patient.agent
            .patch("/api/care-plan/steps/99999999")
            .set("X-CSRF-Token", patient.csrf)
            .send({ done: true });

        expect(res.status).toBe(404);
    });
});

// ---------------------------------------------------------------------------

describe("safety plan", () => {
    it("reports no plan before one has been written", async () => {
        // The client distinguishes "not written yet" from "written and empty",
        // because a patient who deliberately left the coping section blank must
        // not be prompted to fill it in the moment they open the page.
        const patient = await createUser("patient");

        const res = await patient.agent.get("/api/safety-plan");

        expect(res.status).toBe(200);
        expect(res.body.data).toBeNull();
    });

    it("saves the plan the patient wrote", async () => {
        const patient = await createUser("patient");

        const res = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                warningSigns: "Not replying to anyone, staying in bed.",
                copingStrategies: "Cold water on my face. Walk to the park.",
                reasonsToLive: "My little brother looks at me like I am the strong one.",
                contacts: JSON.stringify([{ name: "Rani", phone: "+628111", relationship: "sister" }]),
                professionalContact: "Dr Akmal, +628222",
                locationToBeSafe: "Mum's house. Photo of the dog.",
            });

        expect(res.status).toBe(200);
        const stored = await prisma.safetyPlan.findUnique({ where: { userId: patient.id } });
        expect(stored?.warningSigns).toContain("staying in bed");
        expect(stored?.professionalContact).toBe("Dr Akmal, +628222");
        expect(stored?.locationToBeSafe).toContain("Mum's house");
    });

    it("replaces the plan on a second save instead of creating a second one", async () => {
        // `userId` is unique, so a patient editing their plan repeatedly should
        // never have to know whether this is their first save - and a second row
        // would leave the client choosing between two versions of a crisis
        // document, which is the last thing anyone needs during one.
        const patient = await createUser("patient");

        const first = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ warningSigns: "First version.", copingStrategies: "Walk." });
        const second = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ warningSigns: "Second version.", copingStrategies: "Call Rani." });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body.data.id).toBe(first.body.data.id);
        expect(await prisma.safetyPlan.count({ where: { userId: patient.id } })).toBe(1);

        const stored = await prisma.safetyPlan.findUnique({ where: { userId: patient.id } });
        expect(stored?.warningSigns).toBe("Second version.");
        expect(stored?.copingStrategies).toBe("Call Rani.");
    });

    it("returns the saved plan on read, so the patient sees their own words back", async () => {
        const patient = await createUser("patient");
        await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ reasonsToLive: "Wanted to see the sea again." });

        const res = await patient.agent.get("/api/safety-plan");

        expect(res.status).toBe(200);
        expect(res.body.data.reasonsToLive).toBe("Wanted to see the sea again.");
    });

    it("strips markup out of the stored sections", async () => {
        // This is the one place in the product a patient types into a field
        // another person later renders, including a clinician reading it in a
        // session. Whatever else happens, the stored text has to be inert.
        const patient = await createUser("patient");

        await patient.agent.put("/api/safety-plan").set("X-CSRF-Token", patient.csrf).send({
            warningSigns: "<img src=x onerror=alert(1)> I go quiet.",
            copingStrategies: "<script>steal()</script>Call Rani.",
        });

        const stored = await prisma.safetyPlan.findUnique({ where: { userId: patient.id } });
        expect(stored?.warningSigns).not.toContain("<img");
        expect(stored?.copingStrategies).not.toContain("<script>");
    });

    it("strips markup out of a stored goal detail", async () => {
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);

        await patient.agent
            .post(`/api/care-plan/${plan.id}/goals`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ title: "Ask for help", detail: "<img src=x onerror=alert(1)> In person." });

        const goal = await prisma.careGoal.findFirst({ where: { carePlanId: plan.id } });
        expect(goal?.detail).not.toContain("<img");
    });
});

// ---------------------------------------------------------------------------

describe("safety plan ownership, clinician read side", () => {
    it("lets a treating clinician read the plan", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await link(patient.id, doctor.id, "confirmed");
        await writeSafetyPlan(patient.id);

        const res = await doctor.agent.get(`/api/safety-plan/patient/${patient.id}`);

        expect(res.status).toBe(200);
        expect(res.body.data.userId).toBe(patient.id);
        expect(res.body.data.warningSigns).toContain("Not answering messages");
    });

    it("lets a clinician with a completed appointment read the plan", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await link(patient.id, doctor.id, "completed");
        await writeSafetyPlan(patient.id);

        const res = await doctor.agent.get(`/api/safety-plan/patient/${patient.id}`);

        expect(res.status).toBe(200);
    });

    it("reports no plan rather than an error when a patient has not written one", async () => {
        // A clinician opening a patient with nothing on file needs to see an
        // empty state, not a failure - the absence of a plan is the finding.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await link(patient.id, doctor.id, "confirmed");

        const res = await doctor.agent.get(`/api/safety-plan/patient/${patient.id}`);

        expect(res.status).toBe(200);
        expect(res.body.data).toBeNull();
    });

    it("refuses a clinician with no relationship to the patient", async () => {
        const patient = await createUser("patient");
        const stranger = await createDoctor();
        await writeSafetyPlan(patient.id);

        const res = await stranger.agent.get(`/api/safety-plan/patient/${patient.id}`);

        expect(res.status).toBe(403);
    });

    it("refuses a clinician whose appointment was cancelled", async () => {
        const patient = await createUser("patient");
        const former = await createDoctor();
        await link(patient.id, former.id, "cancelled");
        await writeSafetyPlan(patient.id);

        const res = await former.agent.get(`/api/safety-plan/patient/${patient.id}`);

        expect(res.status).toBe(403);
    });

    it("refuses a patient reading another patient's plan through the clinician route", async () => {
        // The route is gated on `doctor`, so this is stopped at the gate rather
        // than by the ownership check. Asserted here because the two mechanisms
        // are independent and either one alone leaving the other is the risk.
        const owner = await createUser("patient");
        const other = await createUser("patient");
        await writeSafetyPlan(owner.id);

        const res = await other.agent.get(`/api/safety-plan/patient/${owner.id}`);

        expect(res.status).toBe(403);
    });

    it("does not disclose whether a plan exists to an unauthorised reader", async () => {
        // A 403 for a plan that exists and the same 403 for one that does not:
        // the response has to be identical either way, or this endpoint becomes
        // an oracle for which of a clinician's or stranger's patients has a
        // crisis plan.
        const withPlan = await createUser("patient");
        const withoutPlan = await createUser("patient");
        await writeSafetyPlan(withPlan.id);
        const stranger = await createDoctor();

        const first = await stranger.agent.get(`/api/safety-plan/patient/${withPlan.id}`);
        const second = await stranger.agent.get(`/api/safety-plan/patient/${withoutPlan.id}`);

        expect(first.status).toBe(403);
        expect(second.status).toBe(403);
        expect(first.body.message).toBe(second.body.message);
    });
});

// ---------------------------------------------------------------------------

describe("safety plan review", () => {
    it("stamps lastReviewedAt when a treating clinician records a review", async () => {
        // The reason the field exists at all: a plan written alone in a moment of
        // good intent is materially weaker than one gone through with somebody,
        // and the timestamp is how a clinician can tell the difference at a
        // glance. So the stamp has to be real, and it has to be now.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await link(patient.id, doctor.id, "confirmed");
        await writeSafetyPlan(patient.id);
        const before = new Date();

        const res = await doctor.agent
            .post(`/api/safety-plan/patient/${patient.id}/reviewed`)
            .set("X-CSRF-Token", doctor.csrf);

        expect(res.status).toBe(200);
        const stored = await prisma.safetyPlan.findUnique({ where: { userId: patient.id } });
        expect(stored?.lastReviewedAt).not.toBeNull();
        expect(stored!.lastReviewedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    });

    it("leaves lastReviewedAt null when the patient saves their own plan", async () => {
        // Saving and reviewing are deliberately separate endpoints. If writing a
        // plan stamped a review, the distinction between "written alone" and
        // "co-authored" would disappear and the field would be decoration.
        const patient = await createUser("patient");

        await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ warningSigns: "I go quiet." });

        const stored = await prisma.safetyPlan.findUnique({ where: { userId: patient.id } });
        expect(stored?.lastReviewedAt).toBeNull();
    });

    it("keeps the review stamp across a later patient save", async () => {
        // A review is a fact about what happened. A patient tidying their own
        // document afterwards must not erase the record that a clinician sat
        // with them and read it through.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await link(patient.id, doctor.id, "confirmed");
        await writeSafetyPlan(patient.id);

        await doctor.agent
            .post(`/api/safety-plan/patient/${patient.id}/reviewed`)
            .set("X-CSRF-Token", doctor.csrf);
        const reviewed = await prisma.safetyPlan.findUnique({ where: { userId: patient.id } });

        await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ warningSigns: "I go quiet and stop eating." });

        const after = await prisma.safetyPlan.findUnique({ where: { userId: patient.id } });
        expect(after?.lastReviewedAt?.getTime()).toBe(reviewed?.lastReviewedAt?.getTime());
    });

    it("refuses a clinician with no relationship to the patient", async () => {
        const patient = await createUser("patient");
        const stranger = await createDoctor();
        await writeSafetyPlan(patient.id);

        const res = await stranger.agent
            .post(`/api/safety-plan/patient/${patient.id}/reviewed`)
            .set("X-CSRF-Token", stranger.csrf);

        expect(res.status).toBe(403);
        const stored = await prisma.safetyPlan.findUnique({ where: { userId: patient.id } });
        expect(stored?.lastReviewedAt).toBeNull();
    });

    it("refuses a clinician whose appointment was cancelled", async () => {
        const patient = await createUser("patient");
        const former = await createDoctor();
        await link(patient.id, former.id, "cancelled");
        await writeSafetyPlan(patient.id);

        const res = await former.agent
            .post(`/api/safety-plan/patient/${patient.id}/reviewed`)
            .set("X-CSRF-Token", former.csrf);

        expect(res.status).toBe(403);
    });

    it("404s when the patient has not written a plan yet", async () => {
        // Distinct from 403 on purpose: the clinician is allowed to ask, and the
        // answer is "there is nothing to review", not "you may not".
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await link(patient.id, doctor.id, "confirmed");

        const res = await doctor.agent
            .post(`/api/safety-plan/patient/${patient.id}/reviewed`)
            .set("X-CSRF-Token", doctor.csrf);

        expect(res.status).toBe(404);
    });

    it("refuses a non-numeric patient id with 400 rather than reaching the service", async () => {
        // Left unvalidated this becomes `NaN` in the query, which is either a 500
        // or - worse - something Prisma coerces into a query that still matches.
        const doctor = await createDoctor();

        const res = await doctor.agent.get("/api/safety-plan/patient/not-a-number");

        expect(res.status).toBe(400);
    });
});

// ---------------------------------------------------------------------------

describe("care plan and safety plan validation", () => {
    it("rejects an over-long safety plan section with 400, not 500", async () => {
        // These are the two free-text surfaces in the product and an unbounded
        // box on a crisis document is an invitation to paste something nobody
        // has read. The bound has to be a rejection the client can show, not a
        // server error.
        const patient = await createUser("patient");

        const res = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ warningSigns: "x".repeat(4001) });

        expect(res.status).toBe(400);
        expect(await prisma.safetyPlan.count({ where: { userId: patient.id } })).toBe(0);
    });

    it("accepts a section at exactly the maximum length", async () => {
        // The boundary case, so an off-by-one in the bound cannot silently
        // start rejecting text a patient genuinely needs room for.
        const patient = await createUser("patient");
        const text = "y".repeat(4000);

        const res = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ copingStrategies: text });

        expect(res.status).toBe(200);
        const stored = await prisma.safetyPlan.findUnique({ where: { userId: patient.id } });
        expect(stored?.copingStrategies).toHaveLength(4000);
    });

    it("rejects an over-long goal detail with 400, not 500", async () => {
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);

        const res = await patient.agent
            .post(`/api/care-plan/${plan.id}/goals`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ title: "A reasonable title", detail: "z".repeat(2001) });

        expect(res.status).toBe(400);
        expect(await prisma.careGoal.count({ where: { carePlanId: plan.id } })).toBe(0);
    });

    it("rejects an over-long plan summary with 400, not 500", async () => {
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);

        const res = await patient.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ summary: "w".repeat(4001) });

        expect(res.status).toBe(400);
        const stored = await prisma.carePlan.findUnique({ where: { id: plan.id } });
        expect(stored?.summary).toBeNull();
    });

    it("rejects an over-long contact list with 400, not 500", async () => {
        const patient = await createUser("patient");

        const res = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ contacts: "c".repeat(2001) });

        expect(res.status).toBe(400);
    });

    it("rejects an over-long professional contact with 400, not 500", async () => {
        const patient = await createUser("patient");

        const res = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ professionalContact: "p".repeat(256) });

        expect(res.status).toBe(400);
    });

    it("rejects an unknown field rather than storing it", async () => {
        // Every schema here is strict. A field that is silently dropped is a
        // patient who believes they wrote something down and did not, which on
        // a safety plan is the worst possible place for that.
        const patient = await createUser("patient");

        const res = await patient.agent
            .put("/api/safety-plan")
            .set("X-CSRF-Token", patient.csrf)
            .send({ warningSigns: "I go quiet.", favouriteColour: "blue" });

        expect(res.status).toBe(400);
        expect(await prisma.safetyPlan.count({ where: { userId: patient.id } })).toBe(0);
    });

    it("rejects a goal title over the column width with 400, not 500", async () => {
        // The column is `VarChar(200)`. If the bound and the column ever drift
        // apart, this is the request that turns a typo into a 500 on the one
        // screen a patient is mid-way through filling in.
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);

        const res = await patient.agent
            .post(`/api/care-plan/${plan.id}/goals`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ title: "t".repeat(201) });

        expect(res.status).toBe(400);
    });

    it("rejects a plan title over the column width with 400, not 500", async () => {
        const patient = await createUser("patient");
        const plan = await seedPlan(patient.id);

        const res = await patient.agent
            .put(`/api/care-plan/${plan.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ title: "t".repeat(161) });

        expect(res.status).toBe(400);
    });
});