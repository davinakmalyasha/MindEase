import { describe, it, expect } from "vitest";
import speakeasy from "speakeasy";
import {
    createUser,
    createDoctor,
    setupClient,
    accessTokenFrom,
    grantPaidPackage,
    PASSWORD,
} from "./helpers";
import { prisma } from "../src/app";
import { WaitlistService } from "../src/services/waitlist.service";

// Local YYYY-MM-DD (matches how the server parses calendar dates)
const futureDate = (days = 3) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
};

const book = (
    agent: any,
    csrf: string,
    payload: Record<string, any>
) =>
    agent
        .post("/api/appointments/book")
        .set("X-CSRF-Token", csrf)
        .send({ consultationType: "video", startTime: "10:00", endTime: "11:00", ...payload });

describe("Booking hardening", () => {
    it("rejects bookings for unverified doctors", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor(undefined, { verified: false });

        const res = await book(patient.agent, patient.csrf, {
            doctorId: doctor.doctorId,
            appointmentDate: futureDate(),
        });

        expect(res.status).toBe(400);
        expect(res.body.message).toContain("not accepting bookings");
    });

    it("lets patients cancel a confirmed session more than 24h ahead", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        const booked = await book(patient.agent, patient.csrf, {
            doctorId: doctor.doctorId,
            appointmentDate: futureDate(3),
            idempotencyKey: `grace-ok-${Date.now()}`,
        });
        expect(booked.status).toBe(201);
        const appId = booked.body.data.id;

        await doctor.agent
            .put(`/api/appointments/${appId}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "confirmed" });

        const cancel = await patient.agent
            .put(`/api/appointments/${appId}/status`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "cancelled" });
        expect(cancel.status).toBe(200);
    });

    it("blocks cancelling a confirmed session inside the 24-hour window", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        // Confirmed session that already started today → inside the window
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const app = await prisma.appointment.create({
            data: {
                userId: patient.id,
                doctorId: doctor.doctorId,
                appointmentDate: today,
                startTime: "00:30",
                endTime: "01:30",
                consultationType: "video",
                status: "confirmed",
            },
        });

        const cancel = await patient.agent
            .put(`/api/appointments/${app.id}/status`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "cancelled" });
        expect(cancel.status).toBe(403);
        expect(cancel.body.message).toContain("24 hours");

        // The doctor CAN still cancel it
        const docCancel = await doctor.agent
            .put(`/api/appointments/${app.id}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "cancelled" });
        expect(docCancel.status).toBe(200);
    });
});

describe("Referral session credits", () => {
    it("earns a credit on the referred patient's first completion and spends it automatically", async () => {
        const referrer = await createUser("patient");
        const profileRes = await referrer.agent.get("/api/users/profile");
        const code = profileRes.body.data.referralCode;
        expect(code).toBeTruthy();

        const doctor = await createDoctor();
        // Credits only apply to priced sessions
        await prisma.doctor.update({ where: { id: doctor.doctorId }, data: { price: 150000 } });

        // Referred user registers via invite link
        const { agent, csrf } = await setupClient();
        const reg = await agent
            .post("/api/auth/register")
            .set("X-CSRF-Token", csrf)
            .send({
                email: `referred-hard-${Date.now()}@test.app`,
                password: PASSWORD,
                name: "Referred",
                role: "patient",
                phone_number: "+6281234567890",
                referralCode: code,
            });
        expect(reg.status).toBe(201);

        // No credits yet: first booking is NOT covered
        const firstBook = await book(agent, csrf, {
            doctorId: doctor.doctorId,
            appointmentDate: futureDate(3),
            idempotencyKey: `ref-first-${Date.now()}`,
        });
        expect(firstBook.status).toBe(201);
        expect(firstBook.body.data.creditApplied).toBe(false);

        // Complete the referred patient's first session → referrer earns a credit
        const appId = firstBook.body.data.id;
        await doctor.agent.put(`/api/appointments/${appId}/status`).set("X-CSRF-Token", doctor.csrf).send({ status: "confirmed" });
        await doctor.agent.put(`/api/appointments/${appId}/status`).set("X-CSRF-Token", doctor.csrf).send({ status: "completed" });

        const afterComplete = await referrer.agent.get("/api/users/profile");
        expect(afterComplete.body.data.sessionCredits).toBe(1);
        const referral = await prisma.referral.findFirst({ where: { referrerId: referrer.id } });
        expect(referral?.status).toBe("credited");

        // Referrer books: credit covers the fee automatically
        const spend = await book(referrer.agent, referrer.csrf, {
            doctorId: doctor.doctorId,
            appointmentDate: futureDate(4),
            startTime: "13:00",
            endTime: "14:00",
            idempotencyKey: `ref-spend-${Date.now()}`,
        });
        expect(spend.status).toBe(201);
        expect(spend.body.data.creditApplied).toBe(true);
        expect((await referrer.agent.get("/api/users/profile")).body.data.sessionCredits).toBe(0);

        // Cancelling refunds the credit
        await referrer.agent
            .put(`/api/appointments/${spend.body.data.id}/status`)
            .set("X-CSRF-Token", referrer.csrf)
            .send({ status: "cancelled" });
        expect((await referrer.agent.get("/api/users/profile")).body.data.sessionCredits).toBe(1);
    });
});

describe("Therapy package reservation integrity", () => {
    it("reserves sessions at booking, blocks over-redemption, restores on cancel", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        const create = await doctor.agent
            .post("/api/doctors/packages")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ name: "Single plan", sessionCount: 1, totalPrice: 100000 });
        expect(create.status).toBe(201);
        const pkgId = create.body.data.id;

        const purchase = await grantPaidPackage(patient.id, pkgId);
        const purchaseId = purchase.id;

        const key = `pkg-${Date.now()}`;
        const first = await book(patient.agent, patient.csrf, {
            doctorId: doctor.doctorId,
            appointmentDate: futureDate(3),
            idempotencyKey: `${key}-a`,
            packagePurchaseId: purchaseId,
        });
        expect(first.status).toBe(201);

        // Package is exhausted → over-redemption must fail
        const second = await book(patient.agent, patient.csrf, {
            doctorId: doctor.doctorId,
            appointmentDate: futureDate(4),
            startTime: "12:00",
            endTime: "13:00",
            idempotencyKey: `${key}-b`,
            packagePurchaseId: purchaseId,
        });
        expect(second.status).toBe(400);
        expect(second.body.message).toContain("Package session");

        // Cancelling the first booking restores the session
        await patient.agent
            .put(`/api/appointments/${first.body.data.id}/status`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "cancelled" });

        const restored = await prisma.packagePurchase.findUnique({ where: { id: purchaseId } });
        expect(restored?.sessionsLeft).toBe(1);
        expect(restored?.status).toBe("active");

        const third = await book(patient.agent, patient.csrf, {
            doctorId: doctor.doctorId,
            appointmentDate: futureDate(5),
            startTime: "15:00",
            endTime: "16:00",
            idempotencyKey: `${key}-c`,
            packagePurchaseId: purchaseId,
        });
        expect(third.status).toBe(201);
    });
});

describe("2FA backup codes", () => {
    it("issues single-use recovery codes that work at sign-in exactly once", async () => {
        const user = await createUser("patient");

        const setup = await user.agent.post("/api/account/2fa/setup").set("X-CSRF-Token", user.csrf);
        const secret = setup.body.data.secret as string;
        const enable = await user.agent
            .post("/api/account/2fa/enable")
            .set("X-CSRF-Token", user.csrf)
            .send({ code: speakeasy.totp({ secret, encoding: "base32" }) });
        expect(enable.status).toBe(200);
        const backupCodes: string[] = enable.body.data.backupCodes;
        expect(Array.isArray(backupCodes)).toBe(true);
        expect(backupCodes.length).toBe(10);

        // Login requires 2FA; a backup code completes it.
        // Keep ONE agent so the CSRF cookie and header stay consistent.
        const { agent: loginAgent, csrf: loginCsrf } = await setupClient();

        const login = await loginAgent
            .post("/api/auth/login")
            .set("X-CSRF-Token", loginCsrf)
            .send({ email: user.email, password: PASSWORD });
        expect(login.status).toBe(200);
        expect(login.body.data.requires2FA).toBe(true);

        const verify = await loginAgent
            .post("/api/account/2fa/verify")
            .set("X-CSRF-Token", loginCsrf)
            .send({ token: login.body.data.twoFactorToken, code: backupCodes[0] });
        expect(verify.status).toBe(200);
        // Delivered as an HttpOnly cookie only, never in the response body.
        expect(accessTokenFrom(verify)).toBeTruthy();
        expect(verify.body.data.accessToken).toBeUndefined();

        // The same code cannot be reused
        const secondLogin = await loginAgent
            .post("/api/auth/login")
            .set("X-CSRF-Token", loginCsrf)
            .send({ email: user.email, password: PASSWORD });
        expect(secondLogin.body.data.requires2FA).toBe(true);

        const replay = await loginAgent
            .post("/api/account/2fa/verify")
            .set("X-CSRF-Token", loginCsrf)
            .send({ token: secondLogin.body.data.twoFactorToken, code: backupCodes[0] });
        expect(replay.status).toBe(401);

        // An unused backup code still works
        const thirdVerify = await loginAgent
            .post("/api/account/2fa/verify")
            .set("X-CSRF-Token", loginCsrf)
            .send({ token: secondLogin.body.data.twoFactorToken, code: backupCodes[1] });
        expect(thirdVerify.status).toBe(200);
    });
});

describe("Journal ownership", () => {
    it("only lets the owner edit or delete an entry", async () => {
        const owner = await createUser("patient");
        const stranger = await createUser("patient");

        const created = await owner.agent
            .post("/api/wellness/journal")
            .set("X-CSRF-Token", owner.csrf)
            .send({ content: "Original thoughts" });
        expect(created.status).toBe(201);
        const entryId = created.body.data.id;

        const foreignEdit = await stranger.agent
            .put(`/api/wellness/journal/${entryId}`)
            .set("X-CSRF-Token", stranger.csrf)
            .send({ content: "Hijacked" });
        expect(foreignEdit.status).toBe(404);

        const foreignDelete = await stranger.agent
            .delete(`/api/wellness/journal/${entryId}`)
            .set("X-CSRF-Token", stranger.csrf);
        expect(foreignDelete.status).toBe(404);

        const edit = await owner.agent
            .put(`/api/wellness/journal/${entryId}`)
            .set("X-CSRF-Token", owner.csrf)
            .send({ content: "Revised thoughts" });
        expect(edit.status).toBe(200);
        expect(edit.body.data.content).toBe("Revised thoughts");

        const del = await owner.agent
            .delete(`/api/wellness/journal/${entryId}`)
            .set("X-CSRF-Token", owner.csrf);
        expect(del.status).toBe(200);
        expect(await prisma.journalEntry.findUnique({ where: { id: entryId } })).toBeNull();
    });
});

describe("Waitlist maintenance", () => {
    it("requeues stale notifications and expires ancient waiting entries", async () => {
        const doctor = await createDoctor();
        const stalePatient = await createUser("patient");
        const ancientPatient = await createUser("patient");

        // Notified 72h ago but never booked → back into the queue
        const stale = await prisma.waitlistEntry.create({
            data: {
                doctorId: doctor.doctorId,
                patientId: stalePatient.id,
                status: "notified",
                createdAt: new Date(Date.now() - 72 * 3600 * 1000),
            },
        });

        // Waiting since 100 days ago → dropped entirely
        await prisma.waitlistEntry.create({
            data: {
                doctorId: doctor.doctorId,
                patientId: ancientPatient.id,
                status: "waiting",
                createdAt: new Date(Date.now() - 100 * 24 * 3600 * 1000),
            },
        });

        const result = await WaitlistService.runWaitlistMaintenance();
        expect(result.requeued).toBeGreaterThanOrEqual(1);
        expect(result.expiredWaiting).toBeGreaterThanOrEqual(1);

        // The stale notification is transitioned back to `waiting` in place. The
        // previous implementation deleted and recreated the row, so this asserts
        // the observable state rather than the identity of the row.
        const requeued = await prisma.waitlistEntry.findUnique({ where: { id: stale.id } });
        expect(requeued?.status).toBe("waiting");
        expect(requeued?.notifiedAt).toBeNull();

        expect(
            await prisma.waitlistEntry.findFirst({ where: { patientId: stalePatient.id, status: "waiting" } })
        ).toBeTruthy();
        expect(
            await prisma.waitlistEntry.findFirst({ where: { patientId: ancientPatient.id } })
        ).toBeNull();
    });
});
