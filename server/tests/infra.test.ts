import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, createUser, createDoctor, createAdmin , createMoodEntry } from "./helpers";
import { prisma } from "../src/app";

describe("Notification pagination", () => {
    it("paginates notifications with total metadata", async () => {
        const user = await createUser("patient");
        const base = Date.now();
        for (let i = 0; i < 5; i++) {
            await prisma.notification.create({
                data: {
                    userId: user.id,
                    title: `Notif ${i + 1}`,
                    message: "test",
                    type: "system",
                    createdAt: new Date(base + i * 1000),
                },
            });
        }

        const page1 = await user.agent.get("/api/notifications?page=1&limit=2");
        expect(page1.status).toBe(200);
        expect(page1.body.data.rows.length).toBe(2);
        expect(page1.body.data.total).toBe(5);
        expect(page1.body.data.totalPages).toBe(3);

        const page3 = await user.agent.get("/api/notifications?page=3&limit=2");
        expect(page3.body.data.rows.length).toBe(1);
        expect(page3.body.data.rows[0].title).toBe("Notif 1");
    });
});

describe("Doctor directory pagination", () => {
    it("paginates and exposes review counts", async () => {
        const doctor = await createDoctor();
        await prisma.doctor.update({ where: { id: doctor.doctorId }, data: { verificationStatus: "approved" } });
        const doctor2 = await createDoctor();
        await prisma.doctor.update({ where: { id: doctor2.doctorId }, data: { verificationStatus: "approved" } });

        const res = await request(app).get("/api/doctors?page=1&limit=1");
        expect(res.status).toBe(200);
        expect(res.body.data.rows.length).toBe(1);
        expect(res.body.data.total).toBe(2);
        expect(res.body.data.totalPages).toBe(2);
        expect(res.body.data.rows[0]).toHaveProperty("_count");
    });
});

describe("Admin broadcast", () => {
    it("rejects non-admins", async () => {
        const patient = await createUser("patient");
        const res = await patient.agent
            .post("/api/admin/broadcast")
            .set("X-CSRF-Token", patient.csrf)
            .send({ title: "Hi", message: "Everyone" });
        expect(res.status).toBe(403);
    });

    it("notifies all active users and writes an audit log", async () => {
        const patient = await createUser("patient");
        const admin = await createAdmin();

        const res = await admin.agent
            .post("/api/admin/broadcast")
            .set("X-CSRF-Token", admin.csrf)
            .send({ title: "Maintenance", message: "Platform maintenance tonight." });
        expect(res.status).toBe(200);
        expect(res.body.data.recipients).toBeGreaterThan(0);

        const notifications = await prisma.notification.count({ where: { userId: patient.id } });
        expect(notifications).toBe(1);

        const logs = await prisma.auditLog.findFirst({ where: { action: "admin.broadcast" } });
        expect(logs).toBeTruthy();
    });
});

describe("Data export (GDPR)", () => {
    it("returns the user's data as JSON", async () => {
        const user = await createUser("patient");
        await createMoodEntry(user.id, 4, new Date(), { notes: "Feeling good" });

        const res = await user.agent.get("/api/account/export");
        expect(res.status).toBe(200);
        expect(res.body.user.email).toBe(user.email);
        expect(res.body.moods.length).toBe(1);
        expect(res.body.moods[0].mood).toBe(4);
        expect(Array.isArray(res.body.appointments)).toBe(true);
    });
});

describe("CORS from env", () => {
    it("allows configured origins and rejects others", async () => {
        const ok = await request(app).get("/api/health").set("Origin", "http://localhost:3000");
        expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");

        const bad = await request(app).get("/api/health").set("Origin", "https://evil.example.com");
        expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    });
});
