import { describe, it, expect } from "vitest";
import { createUser, createDoctor } from "./helpers";

const futureDate = (days = 3) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split("T")[0];
};

describe("2FA (TOTP)", () => {
    it("setup returns a secret and QR code", async () => {
        const doctor = await createDoctor();
        const res = await doctor.agent.post("/api/account/2fa/setup").set("X-CSRF-Token", doctor.csrf);
        expect(res.status).toBe(200);
        expect(res.body.data.secret).toBeTruthy();
        expect(res.body.data.qrDataUrl).toContain("data:image");
    });

    it("enable rejects a wrong code", async () => {
        const doctor = await createDoctor();
        await doctor.agent.post("/api/account/2fa/setup").set("X-CSRF-Token", doctor.csrf);
        const res = await doctor.agent
            .post("/api/account/2fa/enable")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ code: "000000" });
        expect(res.status).toBe(400);
    });

    it("enable accepts a valid TOTP code and login requires 2FA", async () => {
        const speakeasy = (await import("speakeasy")).default;
        const doctor = await createDoctor();
        const setup = await doctor.agent.post("/api/account/2fa/setup").set("X-CSRF-Token", doctor.csrf);
        const secret = setup.body.data.secret;

        const code = speakeasy.totp({ secret, encoding: "base32" });
        const enable = await doctor.agent
            .post("/api/account/2fa/enable")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ code });
        expect(enable.status).toBe(200);
        expect(enable.body.data.success).toBe(true);

        // Login now requires 2FA
        const login = await doctor.agent.post("/api/auth/login").set("X-CSRF-Token", doctor.csrf).send({
            email: doctor.email,
            password: doctor.password,
        });
        expect(login.status).toBe(200);
        expect(login.body.data.requires2FA).toBe(true);
        expect(login.body.data.twoFactorToken).toBeTruthy();

        // Complete 2FA with a fresh code
        const code2 = speakeasy.totp({ secret, encoding: "base32" });
        const verify = await doctor.agent
            .post("/api/account/2fa/verify")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ token: login.body.data.twoFactorToken, code: code2 });
        if (verify.status !== 200) {
            console.log("VERIFY FAILED:", JSON.stringify(verify.body), "code2:", code2, "secret:", secret);
        }
        expect(verify.status).toBe(200);
        expect(verify.body.data.accessToken).toBeTruthy();
    });
});
