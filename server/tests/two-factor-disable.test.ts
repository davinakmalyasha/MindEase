import { describe, it, expect, beforeEach, afterEach } from "vitest";
import speakeasy from "speakeasy";
import {
    createUser,
    setupClient,
    accessTokenFrom,
    pinTwoFactorClock,
    unpinTwoFactorClock,
    PASSWORD,
} from "./helpers";
import { prisma } from "../src/app";

/**
 * Disabling two-factor authentication.
 *
 * The most sensitive account operation in the product, and it had no test at all.
 * It is also the one an attacker most wants: downgrading someone's 2FA removes the
 * only thing standing between a stolen password and their medical records and
 * messages.
 *
 * Three properties are asserted, and they are the three that matter:
 *
 *   1. It cannot be reached without a fresh password. A TOTP code proves the
 *      attacker holds the phone, not that they hold the account — phones are
 *      stolen and shoulder-surfed far more often than passwords are guessed.
 *   2. It clears *all* the second-factor material, not just the enabled flag. A
 *      leftover `totpSecret` or set of backup codes is a live bypass for anyone
 *      who later reads the row.
 *   3. Sessions established while 2FA was on cannot be renewed. `revokeAllSessions`
 *      deletes the user's refresh tokens. It does not retroactively invalidate an
 *      access token already in hand — a JWT is valid until it expires, which is
 *      the trade short-lived access tokens make for stateless validation. The
 *      tested boundary is the refresh token, and these tests say so rather than
 *      asserting a guarantee the design does not make.
 *
 * ## Why every test re-authenticates
 *
 * `enable` calls `revokeAllSessions` — correctly, since enabling a second factor
 * must invalidate refresh tokens minted before it. That includes the session which
 * performed the enable, so the agent used to enable is dead for the rest of the
 * test. `enableThenReauth` handles that, and it is why this file has a helper
 * rather than three lines of setup in every test.
 */
const currentCode = (secret: string) => speakeasy.totp({ secret, encoding: "base32" });

/**
 * Enables 2FA for a fresh user, then returns a *newly authenticated* agent along
 * with the TOTP secret and the unused backup codes.
 */
const enableThenReauth = async (role: "patient" | "doctor" = "patient") => {
    const user = await createUser(role);

    const setup = await user.agent
        .post("/api/account/2fa/setup")
        .set("X-CSRF-Token", user.csrf);
    const secret = setup.body.data.secret as string;

    const enable = await user.agent
        .post("/api/account/2fa/enable")
        .set("X-CSRF-Token", user.csrf)
        .send({ code: currentCode(secret) });
    expect(enable.status).toBe(200);

    const { agent, csrf } = await setupClient();
    const login = await agent
        .post("/api/auth/login")
        .set("X-CSRF-Token", csrf)
        .send({ email: user.email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.requires2FA).toBe(true);

    const verify = await agent
        .post("/api/account/2fa/verify")
        .set("X-CSRF-Token", csrf)
        .send({ token: login.body.data.twoFactorToken, code: currentCode(secret) });
    expect(verify.status).toBe(200);

    // The backup codes are handed back because they are the only way to open a
    // *second* session in these tests: TOTP codes are single-use, so a replay guard
    // correctly rejects reusing the step the first session just consumed. A backup
    // code is also the realistic second credential.
    return {
        agent,
        csrf,
        secret,
        user,
        backupCodes: enable.body.data.backupCodes as string[],
        password: PASSWORD,
    };
};

describe("TwoFactorService.disable", () => {
    beforeEach(() => pinTwoFactorClock());
    afterEach(() => unpinTwoFactorClock());

    it("requires the account password, not just the TOTP code", async () => {
        const { agent, csrf, secret, user } = await enableThenReauth();

        // No password field at all: rejected by the request schema. The 400 is the
        // contract; the wording comes from zod, so it is not asserted on.
        const noPassword = await agent
            .post("/api/account/2fa/disable")
            .set("X-CSRF-Token", csrf)
            .send({ code: currentCode(secret) });
        expect(noPassword.status).toBe(400);

        // A wrong password reaches the service and is refused there, and this time
        // the message names the requirement.
        const wrongPassword = await agent
            .post("/api/account/2fa/disable")
            .set("X-CSRF-Token", csrf)
            .send({ code: currentCode(secret), password: "not-the-password" });
        expect(wrongPassword.status).toBe(400);
        expect(String(wrongPassword.body.message || "")).toMatch(/password/i);

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(after?.totpEnabled).toBe(true);
        expect(after?.totpSecret).toBe(secret);
    });

    it("rejects an invalid TOTP code even with the correct password", async () => {
        const { agent, csrf, user } = await enableThenReauth();

        const bad = await agent
            .post("/api/account/2fa/disable")
            .set("X-CSRF-Token", csrf)
            .send({ code: "000000", password: PASSWORD });
        expect(bad.status).toBe(400);
        expect(String(bad.body.message || "")).toMatch(/invalid code/i);

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(after?.totpEnabled).toBe(true);
    });

    it("refuses when 2FA was never enabled", async () => {
        const user = await createUser("patient");
        const res = await user.agent
            .post("/api/account/2fa/disable")
            .set("X-CSRF-Token", user.csrf)
            .send({ code: "123456", password: PASSWORD });
        expect(res.status).toBe(400);
        expect(String(res.body.message || "")).toMatch(/not enabled/i);
    });

    it("clears every piece of second-factor material, not just the flag", async () => {
        const { agent, csrf, secret, user } = await enableThenReauth();

        const before = await prisma.user.findUnique({ where: { id: user.id } });
        expect(before?.totpEnabled).toBe(true);
        expect(before?.backupCodes).toBeTruthy();
        // `lastTotpStep` is deliberately not asserted here: it is only set when a
        // code is consumed at sign-in, so it is null on a freshly enabled account.

        const res = await agent
            .post("/api/account/2fa/disable")
            .set("X-CSRF-Token", csrf)
            .send({ code: currentCode(secret), password: PASSWORD });
        expect(res.status).toBe(200);

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(after?.totpEnabled).toBe(false);
        // A surviving secret is a live bypass: anything that later reads this row
        // could re-enable 2FA and mint valid codes for it.
        expect(after?.totpSecret).toBeNull();
        expect(after?.backupCodes).toBeNull();
        expect(after?.lastTotpStep).toBeNull();
    });

    it("kills the refresh token, so a post-2FA session cannot be renewed", async () => {
        const { agent, csrf, secret } = await enableThenReauth();

        const disable = await agent
            .post("/api/account/2fa/disable")
            .set("X-CSRF-Token", csrf)
            .send({ code: currentCode(secret), password: PASSWORD });
        expect(disable.status).toBe(200);

        // What `revokeAllSessions` actually guarantees, tested directly.
        const refresh = await agent
            .post("/api/auth/refresh")
            .set("X-CSRF-Token", csrf);
        expect(refresh.status).not.toBe(200);
    });

    it("kills a second, independently authenticated session too", async () => {
        // The realistic case: an attacker holds a session, the owner disables 2FA
        // from their own device. Revocation is user-wide, so it must not depend on
        // which session performed the disable.
        const { user, secret, backupCodes } = await enableThenReauth();

        const { agent: attackerAgent, csrf: attackerCsrf } = await setupClient();
        const login = await attackerAgent
            .post("/api/auth/login")
            .set("X-CSRF-Token", attackerCsrf)
            .send({ email: user.email, password: PASSWORD });
        expect(login.body.data.requires2FA).toBe(true);

        const verify = await attackerAgent
            .post("/api/account/2fa/verify")
            .set("X-CSRF-Token", attackerCsrf)
            // A backup code, not the TOTP code consumed above: the replay guard
            // correctly refuses a second use of the same time step, and working
            // around that would end up testing the guard instead of the revocation.
            .send({ token: login.body.data.twoFactorToken, code: backupCodes[0] });
        expect(verify.status).toBe(200);
        expect(accessTokenFrom(verify)).toBeTruthy();

        // Sanity: the attacker's session can be renewed *before* the downgrade, so a
        // failure below is caused by the disable and not by the setup.
        const refreshBefore = await attackerAgent
            .post("/api/auth/refresh")
            .set("X-CSRF-Token", attackerCsrf);
        expect(refreshBefore.status).toBe(200);

        // The owner disables 2FA from their own signed-in session.
        const { agent: ownerAgent, csrf: ownerCsrf } = await setupClient();
        const ownerLogin = await ownerAgent
            .post("/api/auth/login")
            .set("X-CSRF-Token", ownerCsrf)
            .send({ email: user.email, password: PASSWORD });
        const ownerVerify = await ownerAgent
            .post("/api/account/2fa/verify")
            .set("X-CSRF-Token", ownerCsrf)
            .send({
                token: ownerLogin.body.data.twoFactorToken,
                code: backupCodes[1],
            });
        expect(ownerVerify.status).toBe(200);

        const disable = await ownerAgent
            .post("/api/account/2fa/disable")
            .set("X-CSRF-Token", ownerCsrf)
            .send({ code: currentCode(secret), password: PASSWORD });
        expect(disable.status).toBe(200);

        const refreshAfter = await attackerAgent
            .post("/api/auth/refresh")
            .set("X-CSRF-Token", attackerCsrf);
        expect(refreshAfter.status).not.toBe(200);
    });

    it("cannot be replayed: the same code does not disable twice", async () => {
        const { agent, csrf, secret } = await enableThenReauth();

        const first = await agent
            .post("/api/account/2fa/disable")
            .set("X-CSRF-Token", csrf)
            .send({ code: currentCode(secret), password: PASSWORD });
        expect(first.status).toBe(200);

        // 2FA is off now, so a replay is refused on the "not enabled" check rather
        // than silently succeeding. Pinned because a replay that *did* succeed would
        // mean the flag was never really cleared.
        const replay = await agent
            .post("/api/account/2fa/disable")
            .set("X-CSRF-Token", csrf)
            .send({ code: currentCode(secret), password: PASSWORD });
        expect(replay.status).toBeGreaterThanOrEqual(400);
    });
});