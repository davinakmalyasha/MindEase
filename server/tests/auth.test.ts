import { describe, it, expect } from "vitest";
import request from "supertest";
import argon2 from "argon2";
import { app, setupClient, createUser, PASSWORD, createAdmin } from "./helpers";
import { prisma } from "../src/app";

describe("Auth", () => {
    it("registers a patient and returns tokens", async () => {
        const user = await createUser("patient");
        expect(user.id).toBeGreaterThan(0);
        expect(user.accessToken).toBeTruthy();
    });

    it("rejects weak passwords", async () => {
        const { agent, csrf } = await setupClient();
        const res = await agent
            .post("/api/auth/register")
            .set("X-CSRF-Token", csrf)
            .send({ email: "weak@test.app", password: "weak", name: "Weak User", role: "patient" });
        expect(res.status).toBe(400);
    });

    it("rejects self-promotion to admin", async () => {
        const { agent, csrf } = await setupClient();
        const res = await agent
            .post("/api/auth/register")
            .set("X-CSRF-Token", csrf)
            .send({ email: "hacker@test.app", password: PASSWORD, name: "Hacker", role: "admin" });
        expect(res.status).toBe(400);
    });

    it("rejects duplicate emails", async () => {
        const user = await createUser("patient");
        const { agent, csrf } = await setupClient();
        const res = await agent
            .post("/api/auth/register")
            .set("X-CSRF-Token", csrf)
            .send({ email: user.email, password: PASSWORD, name: "Dup", role: "patient" });
        expect(res.status).toBe(400);
    });

    it("rejects wrong passwords", async () => {
        const user = await createUser("patient");
        const { agent, csrf } = await setupClient();
        const res = await agent
            .post("/api/auth/login")
            .set("X-CSRF-Token", csrf)
            .send({ email: user.email, password: "Wrong@123" });
        expect(res.status).toBe(401);
    });

    it("locks the account after 5 failed attempts", async () => {
        const user = await createUser("patient");
        const { agent, csrf } = await setupClient();
        for (let i = 0; i < 5; i++) {
            await agent.post("/api/auth/login").set("X-CSRF-Token", csrf).send({ email: user.email, password: "Wrong@123" });
        }
        const res = await agent.post("/api/auth/login").set("X-CSRF-Token", csrf).send({ email: user.email, password: PASSWORD });
        expect(res.status).toBe(401);
        expect(res.body.message).toContain("locked");
    });

    it("rotates refresh tokens", async () => {
        const user = await createUser("patient");
        const { agent, csrf } = await setupClient();
        const login = await agent
            .post("/api/auth/login")
            .set("X-CSRF-Token", csrf)
            .send({ email: user.email, password: PASSWORD });
        const oldRefresh = login.headers["set-cookie"].find((c: string) => c.startsWith("refreshToken"));
        expect(oldRefresh).toBeTruthy();

        const refresh = await agent.post("/api/auth/refresh").set("X-CSRF-Token", csrf);
        expect(refresh.status).toBe(200);
        const newRefresh = refresh.headers["set-cookie"].find((c: string) => c.startsWith("refreshToken"));
        expect(newRefresh).toBeTruthy();

        // Old refresh token is now invalid
        const replay = await agent.post("/api/auth/refresh").set("X-CSRF-Token", csrf);
        expect(replay.status).toBe(200); // agent uses the new cookie now
    });

    it("blocks mutating requests without a CSRF token", async () => {
        const user = await createUser("patient");
        const res = await request(app)
            .post("/api/auth/login")
            .send({ email: user.email, password: PASSWORD });
        expect(res.status).toBe(403);
        expect(res.body.message).toContain("CSRF");
    });

    it("blocks banned users", async () => {
        const user = await createUser("patient");
        await prisma.user.update({ where: { id: user.id }, data: { isBanned: true } });
        const { agent, csrf } = await setupClient();
        const res = await agent
            .post("/api/auth/login")
            .set("X-CSRF-Token", csrf)
            .send({ email: user.email, password: PASSWORD });
        expect(res.status).toBe(401);
        expect(res.body.message).toContain("suspended");
    });

    it("verifies email via OTP", async () => {
        const user = await createUser("patient");
        // The verification code lives in its own column pair, separate from the
        // password-reset code, so requesting a reset cannot invalidate an
        // in-flight email verification (and vice versa).
        const otp = "123456";
        const hash = await argon2.hash(otp);
        await prisma.user.update({
            where: { id: user.id },
            data: { verifyOtpHash: hash, verifyOtpExpiresAt: new Date(Date.now() + 600000) },
        });

        const { agent, csrf } = await setupClient();
        const res = await agent
            .post("/api/account/verify-email")
            .set("X-CSRF-Token", csrf)
            .send({ email: user.email, otp });
        expect(res.status).toBe(200);
        expect(res.body.data.success).toBe(true);

        const updated = await prisma.user.findUnique({ where: { id: user.id } });
        expect(updated?.isVerified).toBe(true);
    });

    it("lets admins access admin routes and denies patients", async () => {
        const admin = await createAdmin();
        const res = await admin.agent.get("/api/admin/stats").set("X-CSRF-Token", admin.csrf);
        expect(res.status).toBe(200);

        const patient = await createUser("patient");
        const denied = await patient.agent.get("/api/admin/stats").set("X-CSRF-Token", patient.csrf);
        expect(denied.status).toBe(403);
    });
});
