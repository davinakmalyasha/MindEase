import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import speakeasy from "speakeasy";
import {
    app,
    createUser,
    createDoctor,
    accessTokenFrom,
    pinTwoFactorClock,
    unpinTwoFactorClock,
    PASSWORD,
} from "./helpers";

describe("2FA (TOTP)", () => {
    // Every test here mints a real-clock TOTP code and then makes an HTTP
    // request whose Argon2 work can outlast a 30-second time step. Pinning
    // keeps the whole file deterministic. See `pinTwoFactorClock`.
    beforeEach(() => {
        pinTwoFactorClock();
    });
    afterEach(() => {
        unpinTwoFactorClock();
    });

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
        expect(verify.status).toBe(200);
        // The session is delivered as an HttpOnly cookie only — never in the
        // JSON body, where any script on the page could read it.
        expect(accessTokenFrom(verify)).toBeTruthy();
        expect(verify.body.data.accessToken).toBeUndefined();
    });

    it("does not issue a usable session before the second factor", async () => {
        const user = await createUser("patient");
        const setup = await user.agent.post("/api/account/2fa/setup").set("X-CSRF-Token", user.csrf);
        const secret = setup.body.data.secret;
        const code = speakeasy.totp({ secret, encoding: "base32" });
        await user.agent
            .post("/api/account/2fa/enable")
            .set("X-CSRF-Token", user.csrf)
            .send({ code });

        const login = await user.agent
            .post("/api/auth/login")
            .set("X-CSRF-Token", user.csrf)
            .send({ email: user.email, password: PASSWORD });
        expect(login.body.data.requires2FA).toBe(true);
        const ticket = login.body.data.twoFactorToken;
        expect(ticket).toBeTruthy();

        // No session cookies are set by a login that stopped at the gate.
        const cookieNames = (login.headers["set-cookie"] ?? []).map((c: string) => c.split("=")[0]);
        expect(cookieNames).not.toContain("accessToken");
        expect(cookieNames).not.toContain("refreshToken");

        // A bare request, with no cookie jar of its own, so the only credential
        // presented is the pending ticket. This is the regression the test
        // exists for: the ticket used to be signed with the access-token secret
        // and was accepted verbatim by `authenticate`.
        const asAccessToken = await request(app)
            .get("/api/notifications")
            .set("Authorization", `Bearer ${ticket}`);
        expect(asAccessToken.status).toBe(401);

        // Nor as a refresh token.
        const asRefresh = await request(app)
            .post("/api/auth/refresh")
            .set("Cookie", `refreshToken=${ticket}`);
        expect(asRefresh.status).toBe(403);
    });

    it("rejects a replayed TOTP code", async () => {
        // A captured code stays valid for roughly 90 seconds under the +/- 1
        // step tolerance, so it must not be usable twice.
        const user = await createUser("patient");
        const setup = await user.agent.post("/api/account/2fa/setup").set("X-CSRF-Token", user.csrf);
        const secret = setup.body.data.secret;
        await user.agent
            .post("/api/account/2fa/enable")
            .set("X-CSRF-Token", user.csrf)
            .send({ code: speakeasy.totp({ secret, encoding: "base32" }) });

        const code = speakeasy.totp({ secret, encoding: "base32" });
        const first = await user.agent
            .post("/api/auth/login")
            .set("X-CSRF-Token", user.csrf)
            .send({ email: user.email, password: PASSWORD });
        const ticket = first.body.data.twoFactorToken;

        const used = await user.agent
            .post("/api/account/2fa/verify")
            .set("X-CSRF-Token", user.csrf)
            .send({ token: ticket, code });
        expect(used.status).toBe(200);

        // A second login presents the same captured code.
        const second = await user.agent
            .post("/api/auth/login")
            .set("X-CSRF-Token", user.csrf)
            .send({ email: user.email, password: PASSWORD });
        const replay = await user.agent
            .post("/api/account/2fa/verify")
            .set("X-CSRF-Token", user.csrf)
            .send({ token: second.body.data.twoFactorToken, code });
        expect(replay.status).toBe(401);
    });
});
