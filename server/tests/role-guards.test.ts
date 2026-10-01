import { describe, it, expect } from "vitest";
import request from "supertest";
import { createUser, createDoctor, createAdmin, setupClient, app } from "./helpers";
import { prisma } from "../src/app";

/**
 * Role guards: the 401 and 403 branches of `src/middleware/role.middleware.ts`.
 *
 * ┌─ THIS FILE IS THE ONLY COVERAGE FOR THE UNAUTHENTICATED / WRONG-ROLE ────┐
 * │ PATHS. Every other test in the suite authenticates first, so before it    │
 * │ existed no test in the repository ever asked a guarded route what it does │
 * │ for a caller who is not logged in, or logged in as the wrong role.        │
 * │                                                                          │
 * │ Deleting lines 4-6 of the middleware - the `if (!req.user) return 401` -  │
 * │ would change nothing observable *today*, and that is precisely the       │
 * │ problem: every route that mounts a guard also mounts `authenticate`       │
 * │ first, so the guard's own null check is untested defence in depth. The   │
 * │ day a route mounts `requireDoctor` without `authenticate`, or the two get │
 * │ reordered, every guarded route becomes a 500 on the controllers'         │
 * │ `req.user!` dereference - or an unguarded `req.user.role` read on an     │
 * │ undefined object - and not one assertion in the repository fails.        │
 * │                                                                          │
 * │ The 403 branches are the mirror image: they are only reached by a test    │
 * │ that deliberately signs in as the wrong role.                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Routes used, chosen because they are role-gated and nothing else:
 *   - `requireAdmin`         GET  /api/admin/stats        (admin.routes.ts:11, router-wide)
 *                            GET  /api/admin/users        (admin.routes.ts:14, router-wide)
 *   - `requireDoctor`        GET  /api/safety-plan/patient/:id  (carePlan.routes.ts:49)
 *                            POST /api/wellness/risk-alerts/:id/acknowledge (wellness.routes.ts:57)
 *   - `requireClinicalStaff` GET  /api/wellness/risk-alerts      (wellness.routes.ts:56)
 *     included deliberately, because it is the guard that is *not* `requireDoctor`
 *     and is what proves the other two are mounted and distinct from each other.
 *
 * A note on the 401s, so these cases are not read as covering the middleware's
 * own null check: `authenticate` runs ahead of every role guard and already
 * answers an anonymous request with 401, so the 401 observed here originates
 * there. What these cases protect is the contract a caller can observe - that a
 * guarded route refuses an anonymous caller at all - which is what would stop
 * being true if the guard were removed, and what nothing in the suite checked
 * before.
 */

/** An anonymous caller: a real request with no cookie, no header, no session. */
const anon = () => request(app);

/**
 * An anonymous caller on a mutating route.
 *
 * CSRF runs ahead of authentication, so a bare POST with no session is refused
 * with 403 "Invalid CSRF token" before the role guard is ever reached. `setupClient`
 * is the fix rather than a workaround: it hands back an agent holding only the
 * CSRF cookie and the matching header, so the request is a legitimate one from
 * a browser that has never logged in, and the only thing missing is the session.
 * That makes the 401 an answer about the session rather than about CSRF.
 */
const anonMutating = async () => {
    const { agent, csrf } = await setupClient();
    return { post: (path: string) => agent.post(path).set("X-CSRF-Token", csrf) };
};

describe("role guards - unauthenticated callers", () => {
    it("answers 401 on an admin-only route", async () => {
        const res = await anon().get("/api/admin/stats");
        expect(res.status).toBe(401);
        expect(res.body.status).toBe("error");
    });

    it("answers 401 on a second admin-only route", async () => {
        // `/api/admin/users` is a different handler with a different response
        // body, so a guard that had been moved onto only one of them would show
        // up here rather than passing on `/stats` alone.
        const res = await anon().get("/api/admin/users");
        expect(res.status).toBe(401);
    });

    it("answers 401 on a doctor-only route", async () => {
        const res = await anon().get("/api/safety-plan/patient/1");
        expect(res.status).toBe(401);
    });

    it("answers 401 on a doctor-only mutating route", async () => {
        const anon = await anonMutating();
        const res = await anon.post("/api/wellness/risk-alerts/1/acknowledge");
        expect(res.status).toBe(401);
    });

    it("writes nothing when an anonymous caller tries to acknowledge an alert", async () => {
        // The state assertion matters more than the status: a 401 that still
        // mutated the row would be a 401 that lied. An open disclosure must be
        // left exactly as it was, with no actor recorded against it.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const alert = await prisma.riskAlert.create({
            data: {
                userId: patient.id,
                level: "urgent",
                reason: "PHQ-9 item 9 answered \"several days\".",
                sourceType: "phq9",
                assignedDoctorUserId: doctor.id,
            },
        });
        const anon = await anonMutating();

        const res = await anon.post(`/api/wellness/risk-alerts/${alert.id}/acknowledge`);

        expect(res.status).toBe(401);

        const stored = await prisma.riskAlert.findUnique({ where: { id: alert.id } });
        expect(stored?.acknowledgedAt).toBeNull();
        expect(stored?.acknowledgedById).toBeNull();
        expect(stored?.resolvedAt).toBeNull();
        // And nothing was written to the audit trail naming a nonexistent actor.
        const audited = await prisma.auditLog.findMany({ where: { targetId: alert.id } });
        expect(audited).toHaveLength(0);
    });
});

describe("role guards - authenticated but wrong role", () => {
    it("answers 403 when a patient reaches an admin-only route", async () => {
        const patient = await createUser("patient");
        const res = await patient.agent.get("/api/admin/stats");
        expect(res.status).toBe(403);
        expect(res.body.status).toBe("error");
    });

    it("answers 403 when a doctor reaches an admin-only route", async () => {
        // A doctor is a privileged role and is still refused. The guard is
        // "is an admin", not "is not a patient", so a doctor being let through
        // would be a real widening.
        const doctor = await createDoctor();
        const res = await doctor.agent.get("/api/admin/users");
        expect(res.status).toBe(403);
    });

    it("answers 403 when a patient reaches a doctor-only route", async () => {
        const patient = await createUser("patient");
        const res = await patient.agent.get(`/api/safety-plan/patient/${patient.id}`);
        expect(res.status).toBe(403);
    });

    it("answers 403 when a patient tries to acknowledge a risk alert", async () => {
        const patient = await createUser("patient");
        const alert = await prisma.riskAlert.create({
            data: {
                userId: patient.id,
                level: "urgent",
                reason: "PHQ-9 item 9 answered \"several days\".",
                sourceType: "phq9",
            },
        });

        const res = await patient.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/acknowledge`)
            .set("X-CSRF-Token", patient.csrf);

        expect(res.status).toBe(403);

        const stored = await prisma.riskAlert.findUnique({ where: { id: alert.id } });
        expect(stored?.acknowledgedAt).toBeNull();
        expect(stored?.acknowledgedById).toBeNull();
    });

    it("answers 403 when an admin tries to acknowledge a risk alert", async () => {
        // The sharpest of these cases, and the reason the two guards are named
        // for a specific pairing rather than expressed as a list of allowed
        // roles. An admin is paged for an out-of-hours disclosure and
        // `requireClinicalStaff` lets them read the queue, but acknowledging is
        // a clinician signing off that they have taken responsibility for a
        // disclosure. An admin must not be able to do that.
        const admin = await createAdmin();
        const res = await admin.agent
            .post("/api/wellness/risk-alerts/1/acknowledge")
            .set("X-CSRF-Token", admin.csrf);

        expect(res.status).toBe(403);
    });
});

describe("role guards - the guard is mounted and distinct", () => {
    // Without these, a suite in which every guard returned 403 would pass every
    // case above while proving nothing about the routes actually working.

    it("lets an admin through the admin guard", async () => {
        const admin = await createAdmin();
        const res = await admin.agent.get("/api/admin/stats");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("success");
    });

    it("lets a doctor through the doctor guard", async () => {
        // A confirmed appointment first: the safety-plan read also requires a
        // clinical relationship, so a doctor with no relationship to the patient
        // would be refused by the *service* and the assertion below would be
        // testing the wrong refusal.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await prisma.appointment.create({
            data: {
                // Both relations connected rather than passed as bare ids.
                // Prisma rejects a `data` that mixes the two forms.
                user: { connect: { id: patient.id } },
                doctor: { connect: { userId: doctor.id } },
                appointmentDate: new Date(),
                startTime: "10:00",
                endTime: "11:00",
                status: "confirmed",
                consultationType: "video",
            },
        });

        const res = await doctor.agent.get(`/api/safety-plan/patient/${patient.id}`);

        expect(res.status).toBe(200);
    });

    it("lets a doctor acknowledge, and lets an admin read the queue but not acknowledge", async () => {
        // `requireClinicalStaff` on the read, `requireDoctor` on the write. Both
        // halves of that split are asserted here, so widening either guard is a
        // failing test rather than a silent change to who can close a disclosure.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const admin = await createAdmin();
        const alert = await prisma.riskAlert.create({
            data: {
                userId: patient.id,
                level: "urgent",
                reason: "PHQ-9 item 9 answered \"several days\".",
                sourceType: "phq9",
                assignedDoctorUserId: doctor.id,
            },
        });

        const readByAdmin = await admin.agent.get("/api/wellness/risk-alerts");
        expect(readByAdmin.status).toBe(200);
        expect(readByAdmin.body.data.map((a: { id: number }) => a.id)).toContain(alert.id);

        const ackByDoctor = await doctor.agent
            .post(`/api/wellness/risk-alerts/${alert.id}/acknowledge`)
            .set("X-CSRF-Token", doctor.csrf);
        expect(ackByDoctor.status).toBe(200);
    });

    it("refuses a patient the clinical-staff queue", async () => {
        // The queue returns disclosures of thoughts of self-harm. A patient must
        // not be able to read another patient's.
        const patient = await createUser("patient");
        const res = await patient.agent.get("/api/wellness/risk-alerts");
        expect(res.status).toBe(403);
    });
});
