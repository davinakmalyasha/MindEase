import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, createUser, createDoctor, createAdmin } from "./helpers";
import { prisma } from "../src/app";

describe("Doctor verification workflow", () => {
    it("keeps newly registered doctors hidden from the public directory", async () => {
        const doctor = await createDoctor(undefined, { verified: false });

        const res = await request(app).get("/api/doctors");
        expect(res.status).toBe(200);
        const listed = (res.body.data?.rows || []) as any[];
        expect(listed.some((d) => d.id === doctor.doctorId)).toBe(false);
    });

    it("approves a doctor via the admin endpoint and makes them visible", async () => {
        const doctor = await createDoctor(undefined, { verified: false });
        const admin = await createAdmin();

        const approve = await admin.agent
            .patch(`/api/admin/doctors/${doctor.doctorId}/verification`)
            .set("X-CSRF-Token", admin.csrf)
            .send({ status: "approved" });
        expect(approve.status).toBe(200);

        const res = await request(app).get("/api/doctors");
        const listed = (res.body.data?.rows || []) as any[];
        expect(listed.some((d) => d.id === doctor.doctorId)).toBe(true);
    });

    it("rejects verification updates from non-admins", async () => {
        const doctor = await createDoctor();
        const patient = await createUser("patient");

        const res = await patient.agent
            .patch(`/api/admin/doctors/${doctor.doctorId}/verification`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "approved" });
        expect(res.status).toBe(403);
    });

    it("records verification decisions in the audit log", async () => {
        const doctor = await createDoctor();
        const admin = await createAdmin();

        await admin.agent
            .patch(`/api/admin/doctors/${doctor.doctorId}/verification`)
            .set("X-CSRF-Token", admin.csrf)
            .send({ status: "rejected" });

        const logs = await admin.agent
            .get("/api/admin/audit-logs?limit=50")
            .set("X-CSRF-Token", admin.csrf);
        const actions = ((logs.body.data?.logs || logs.body.data?.rows || []) as any[]).map((l) => l.action);
        expect(actions).toContain("doctor.rejected");
    });

    it("lists pending applications for the admin", async () => {
        await createDoctor(undefined, { verified: false });
        const admin = await createAdmin();

        const res = await admin.agent
            .get("/api/admin/doctors/applications?status=pending")
            .set("X-CSRF-Token", admin.csrf);
        expect(res.status).toBe(200);
        expect(res.body.data.applications.length).toBeGreaterThan(0);
    });
});
