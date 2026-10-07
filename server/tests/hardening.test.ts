import { describe, it, expect, beforeEach, afterEach } from "vitest";
import speakeasy from "speakeasy";
import {
    createUser,
    createDoctor,
    setupClient,
    accessTokenFrom,
    grantPaidPackage,
    pinTwoFactorClock,
    unpinTwoFactorClock,
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
        // 400, not 403: the patient genuinely owns this appointment and is
        // allowed to cancel it — the grace window has simply closed, which is a
        // business-rule violation rather than an authorization failure. The 403
        // here was an artifact of the controller hard-coding one status for the
        // whole endpoint.
        expect(cancel.status).toBe(400);
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

    it("cannot spend one remaining session on two follow-ups at once", async () => {
        // The follow-up path reserved by reading "a purchase with sessions left"
        // and then decrementing by id, where the booking path above already used
        // a conditional decrement. Two follow-ups accepted simultaneously both
        // read the same purchase, both decremented, and one remaining session
        // covered two bookings - leaving `sessionsLeft` at -1.
        //
        // The claim on each *follow-up* is already atomic, so this needs two
        // different follow-ups: the reuse has to be over the shared package, not
        // over one row.
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        const create = await doctor.agent
            .post("/api/doctors/packages")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ name: "Single plan", sessionCount: 1, totalPrice: 100000 });
        const purchaseId = (await grantPaidPackage(patient.id, create.body.data.id)).id;

        // Two completed sessions, so the doctor may propose a follow-up off each.
        const priorAppointments = await Promise.all(
            [3, 4].map((daysAgo) =>
                prisma.appointment.create({
                    data: {
                        userId: patient.id,
                        doctorId: doctor.doctorId,
                        appointmentDate: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
                        startTime: "09:00",
                        endTime: "10:00",
                        status: "completed",
                        consultationType: "video",
                    },
                })
            )
        );

        const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
        const followUps = await Promise.all(
            priorAppointments.map((a, i) =>
                prisma.followUp.create({
                    data: {
                        appointmentId: a.id,
                        doctorId: doctor.doctorId,
                        suggestedDate: future,
                        // Distinct, non-overlapping times, so the conflict check
                        // is not what decides the outcome.
                        startTime: i === 0 ? "09:00" : "11:00",
                        endTime: i === 0 ? "10:00" : "12:00",
                        consultationType: "video",
                        status: "pending",
                    },
                })
            )
        );

        const [first, second] = await Promise.all([
            patient.agent
                .post(`/api/follow-ups/${followUps[0].id}/accept`)
                .set("X-CSRF-Token", patient.csrf)
                .send({}),
            patient.agent
                .post(`/api/follow-ups/${followUps[1].id}/accept`)
                .set("X-CSRF-Token", patient.csrf)
                .send({}),
        ]);

        // Both follow-ups are legitimately accepted - they are separate rows and
        // separate sessions. What must not happen is the *package* being spent
        // twice.
        expect([first.status, second.status]).toEqual([200, 200]);

        const purchase = await prisma.packagePurchase.findUnique({ where: { id: purchaseId } });
        expect(purchase?.sessionsLeft, "one remaining session covered two bookings").toBe(0);
        expect(purchase?.status).toBe("completed");

        // And exactly one appointment carries the reservation, so the ledger says
        // the same thing the counter does.
        const reserved = await prisma.appointment.count({
            where: { packagePurchaseId: purchaseId },
        });
        expect(reserved).toBe(1);
    });

    it("cannot decline a follow-up that was accepted concurrently", async () => {
        // The sequential case was already safe: `respond` rejects a second
        // response before it branches, so a test that accepts and *then* declines
        // passes against the broken code too. Only an interleaving exposes it.
        //
        // And the natural interleaving does not: decline does one read and one
        // write, while accept validates and opens a transaction, so decline's
        // write normally lands first and accept's claim then fails cleanly. Firing
        // both with Promise.all and asserting the invariant passes on the broken
        // code - I checked - which makes it a test that proves nothing.
        //
        // The window is real, though: any latency on the decline write - a loaded
        // connection pool, a slow disk, a retry - lets accept's claim commit
        // first. So the window is injected rather than waited for. This is a real
        // interleaving, reached on purpose instead of by luck.
        const original = prisma.followUp.update.bind(prisma.followUp);
        // @ts-expect-error - delaying one write to widen a window that exists
        prisma.followUp.update = async (args: unknown) => {
            await new Promise((r) => setTimeout(r, 250));
            return original(args as never);
        };

        try {
            const patient = await createUser("patient");
            const doctor = await createDoctor();

            const prior = await prisma.appointment.create({
                data: {
                    userId: patient.id,
                    doctorId: doctor.doctorId,
                    appointmentDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
                    startTime: "09:00",
                    endTime: "10:00",
                    status: "completed",
                    consultationType: "video",
                },
            });
            const followUp = await prisma.followUp.create({
                data: {
                    appointmentId: prior.id,
                    doctorId: doctor.doctorId,
                    suggestedDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
                    startTime: "09:00",
                    endTime: "10:00",
                    consultationType: "video",
                    status: "pending",
                },
            });

            // Decline starts first, so its read sees `pending` and its write is
            // held. Accept starts while that write is in flight and claims the row
            // in the meantime.
            const declining = patient.agent
                .post(`/api/follow-ups/${followUp.id}/decline`)
                .set("X-CSRF-Token", patient.csrf)
                .send({});
            await new Promise((r) => setTimeout(r, 80));
            const accepting = patient.agent
                .post(`/api/follow-ups/${followUp.id}/accept`)
                .set("X-CSRF-Token", patient.csrf)
                .send({});

            await Promise.all([declining, accepting]);

            const after = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
            const created = await prisma.appointment.count({
                where: { userId: patient.id, status: "pending" },
            });

            // Whichever branch won, the two records must agree. `declined` with an
            // appointment beside it is the defect: the patient is booked into a
            // session the follow-up says they refused.
            if (after.status === "accepted") {
                expect(created, "accepted but no appointment").toBe(1);
            } else {
                expect(after.status).toBe("declined");
                expect(created, "declined, but an appointment was created anyway").toBe(0);
            }
        } finally {
            // @ts-expect-error - restoring
            prisma.followUp.update = original;
        }
    });

    it("cannot refund one cancellation twice", async () => {
        // `updateStatus` read the appointment, decided the transition was legal,
        // and then wrote the new status by id. Two cancels at the same moment
        // both read `pending`, both passed the terminal-state check, and both
        // wrote `cancelled` - so the refund below ran twice and a patient could
        // cancel once and come away with a free session. The slot release and the
        // waitlist notification ran twice as well.
        //
        // A double-tap on Cancel is the whole reproduction; no unusual client is
        // needed.
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        const create = await doctor.agent
            .post("/api/doctors/packages")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ name: "Single plan", sessionCount: 1, totalPrice: 100000 });
        const purchaseId = (await grantPaidPackage(patient.id, create.body.data.id)).id;

        const booked = await book(patient.agent, patient.csrf, {
            doctorId: doctor.doctorId,
            appointmentDate: futureDate(3),
            packagePurchaseId: purchaseId,
            idempotencyKey: `cancel-race-${Date.now()}`,
        });
        expect(booked.status).toBe(201);
        const appointmentId = booked.body.data.id;

        // Spent by the booking.
        const afterBooking = await prisma.packagePurchase.findUnique({ where: { id: purchaseId } });
        expect(afterBooking?.sessionsLeft).toBe(0);

        const [first, second] = await Promise.all([
            patient.agent
                .put(`/api/appointments/${appointmentId}/status`)
                .set("X-CSRF-Token", patient.csrf)
                .send({ status: "cancelled" }),
            patient.agent
                .put(`/api/appointments/${appointmentId}/status`)
                .set("X-CSRF-Token", patient.csrf)
                .send({ status: "cancelled" }),
        ]);

        // Exactly one transition, so exactly one refund. The loser is told the
        // appointment moved rather than being told it succeeded.
        const statuses = [first.status, second.status].sort();
        expect(statuses, `got ${first.status} and ${second.status}`).toEqual([200, 409]);

        const afterCancel = await prisma.packagePurchase.findUnique({ where: { id: purchaseId } });
        expect(afterCancel?.sessionsLeft, "one cancellation refunded twice").toBe(1);
    });
});

describe("2FA backup codes", () => {
    // Pinned so a code minted with the real clock cannot fall outside the
    // server's tolerance window while this test's Argon2 work runs. See
    // `pinTwoFactorClock`.
    beforeEach(() => {
        pinTwoFactorClock();
    });
    afterEach(() => {
        unpinTwoFactorClock();
    });

    it("issues single-use recovery codes that work at sign-in exactly once", async () => {
        const user = await createUser("patient");

        const setup = await user.agent.post("/api/account/2fa/setup")
        .set("X-CSRF-Token", user.csrf)
        .send({ password: PASSWORD });
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

    it("cannot spend one code twice at the same moment", async () => {
        // The reuse test above is sequential, and the write always removes the
        // code, so it cannot see this. The old implementation read the array,
        // verified against each hash (argon2 - slow enough for the other request
        // to slip in) and then wrote "the array minus that hash". Two requests
        // racing the same code both verified, and both wrote an array computed
        // from the state before either write - so both were admitted while the
        // code was removed only once.
        //
        // It is the shape of bug a serial suite cannot find, which is why it is
        // reproduced here by firing both verifications without awaiting the first.
        const user = await createUser("patient");

        const setup = await user.agent
            .post("/api/account/2fa/setup")
            .set("X-CSRF-Token", user.csrf)
            .send({ password: PASSWORD });
        const secret = setup.body.data.secret as string;
        const enable = await user.agent
            .post("/api/account/2fa/enable")
            .set("X-CSRF-Token", user.csrf)
            .send({ code: speakeasy.totp({ secret, encoding: "base32" }) });
        const backupCodes: string[] = enable.body.data.backupCodes;

        // Two logins, so there are two independent 2FA tokens: the race is over
        // the *code*, not over the ticket.
        const a = await setupClient();
        const b = await setupClient();
        const loginA = await a.agent
            .post("/api/auth/login")
            .set("X-CSRF-Token", a.csrf)
            .send({ email: user.email, password: PASSWORD });
        const loginB = await b.agent
            .post("/api/auth/login")
            .set("X-CSRF-Token", b.csrf)
            .send({ email: user.email, password: PASSWORD });
        expect(loginA.body.data.requires2FA).toBe(true);
        expect(loginB.body.data.requires2FA).toBe(true);

        const code = backupCodes[0];
        const [first, second] = await Promise.all([
            a.agent
                .post("/api/account/2fa/verify")
                .set("X-CSRF-Token", a.csrf)
                .send({ token: loginA.body.data.twoFactorToken, code }),
            b.agent
                .post("/api/account/2fa/verify")
                .set("X-CSRF-Token", b.csrf)
                .send({ token: loginB.body.data.twoFactorToken, code }),
        ]);

        // Exactly one session, not two. The assertions are on both sides so a
        // failure says which shape it took: two admissions is the reuse bug,
        // zero is a broken consume.
        const statuses = [first.status, second.status].sort();
        expect(statuses, `got ${first.status} and ${second.status}`).toEqual([200, 401]);
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

/**
 * The `include`-everything leak, in the two places it survived the first fix.
 *
 * The public doctor directory leaked bankAccount, bankName and bankHolder to
 * anonymous callers. That was fixed with an explicit `select` allowlist and a
 * test. Two sibling queries used `include: { user: { select } }` and
 * `include: { doctor: true }` respectively, both of which look restricted and
 * neither of which is: the first selects the *inner* user and not the outer
 * doctor, the second selects nothing at all. Both serialised every Doctor scalar
 * to an authenticated caller who had no business seeing them.
 *
 * The assertions are `not.toContain` on the serialised body rather than an exact
 * key set, so they fail on the symptom - the field being present - regardless of
 * which query shape produced it.
 */
describe("Doctor payout details never leave the platform", () => {
    /**
     * The Doctor columns that must never reach a patient.
     *
     * Only the payout details. `bio` and `education` are deliberately public -
     * the public profile renders them, and `doctor-directory.test.ts` asserts
     * their absence from the *directory* only because that endpoint is
     * deliberately terse, not because a clinician's professional bio is a
     * secret from their own patient. `licenseNumber` is published on the
     * public profile by an explicit product decision so a patient can check a
     * clinician's registration.
     *
     * An earlier draft of this test asserted on `bio` as well and failed: the
     * appointment list is allowed to show it.
     */
    const PAYOUT_FIELDS = ["bankAccount", "bankName", "bankHolder"];

    const expectNoPayoutDetails = (body: unknown) => {
        const serialised = JSON.stringify(body);
        for (const field of PAYOUT_FIELDS) {
            expect(serialised, `${field} must not be serialised`).not.toContain(field);
        }
    };

    /** Books and confirms one session so the patient has a treating clinician. */
    const withConfirmedSession = async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: doctor.doctorId,
                appointmentDate: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
            });
        await doctor.agent
            .put(`/api/appointments/${book.body.data.id}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "confirmed" });
        return { patient, doctor };
    };

    it("are absent from the patient's own appointment list", async () => {
        const { patient } = await withConfirmedSession();

        const res = await patient.agent.get("/api/appointments/my");

        expect(res.status).toBe(200);
        expect(res.body.data.rows.length).toBeGreaterThan(0);
        expectNoPayoutDetails(res.body);
    });

    it("are absent from a patient's package purchases", async () => {
        const { patient, doctor } = await withConfirmedSession();
        // grantPaidPackage takes the Package id, not the doctor's.
        const pkg = await prisma.package.create({
            data: {
                doctorId: doctor.doctorId,
                name: "Course of six",
                sessionCount: 6,
                totalPrice: 900000,
            },
        });
        await grantPaidPackage(patient.id, pkg.id);

        const res = await patient.agent.get("/api/payments/purchases");

        expect(res.status).toBe(200);
        expect(res.body.data.length).toBeGreaterThan(0);
        expectNoPayoutDetails(res.body);
        // The doctor is still usable - the fix is a projection, not a deletion.
        expect(res.body.data[0].package.doctor.specialty).toBeTruthy();
    });

    it("actually exist on the rows being projected away", async () => {
        // Guards the negative assertions above: if the payout fields were renamed
        // or dropped from the schema, both tests would pass while proving nothing.
        const { doctor } = await withConfirmedSession();
        await prisma.doctor.update({
            where: { id: doctor.doctorId },
            data: { bankAccount: "1234567890", bankName: "Bank", bankHolder: "Dr Test" },
        });

        const row = await prisma.doctor.findUnique({ where: { id: doctor.doctorId } });
        expect(row?.bankAccount).toBe("1234567890");
    });
});