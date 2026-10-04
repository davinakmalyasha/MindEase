import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import speakeasy from "speakeasy";
import argon2 from "argon2";
import {
    app,
    createUser,
    createDoctor,
    createAdmin,
    setupClient,
    pinTwoFactorClock,
    unpinTwoFactorClock,
    PASSWORD,
} from "./helpers";
import { prisma } from "../src/app";
import { signAccessToken, signRefreshToken, signTwoFactorPendingToken, verifyToken } from "../src/lib/tokens";
import { publicMessageFor, AppError } from "../src/utils/appError";
import { dayKey, startOfZonedDay, shiftDayKey, timeToMinutes, overlaps } from "../src/lib/date";

const localDay = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Reads a cookie value out of a response's `Set-Cookie` headers. */
const readCookie = (res: request.Response, name: string): string | undefined => {
    const cookies = res.headers["set-cookie"];
    if (!Array.isArray(cookies)) return undefined;
    for (const cookie of cookies) {
        const match = new RegExp(`^${name}=([^;]*)`).exec(cookie);
        if (match) return decodeURIComponent(match[1]);
    }
    return undefined;
};

/**
 * A CSRF-protected POST that carries no session of its own.
 *
 * A raw `supertest(app)` request must present both the CSRF cookie and the
 * matching header, or the CSRF guard rejects it with 403 before the route is
 * ever reached — which would otherwise be indistinguishable from an
 * authentication failure. The cookie and header must come from the *same*
 * response, so both are captured together.
 */
const postWithCsrf = async (path: string, extraCookie?: string) => {
    const bootstrap = await request(app).get("/api/csrf-token");
    const csrfCookie = readCookie(bootstrap, "csrfToken") as string;
    const csrfHeader = bootstrap.body?.data?.csrfToken as string;
    const jar = [`csrfToken=${csrfCookie}`];
    if (extraCookie) jar.push(extraCookie);
    return request(app).post(path).set("X-CSRF-Token", csrfHeader).set("Cookie", jar.join("; "));
};

describe("Token purpose separation", () => {
    it("refuses a token minted for a different purpose", () => {
        const access = signAccessToken({ id: 1, role: "patient", totpVerified: true });
        const refresh = signRefreshToken(1);
        const pending = signTwoFactorPendingToken(1);

        // Each verifies only under its own purpose.
        expect(verifyToken(access, "access")).toBeTruthy();
        expect(verifyToken(refresh, "refresh")).toBeTruthy();
        expect(verifyToken(pending, "2fa-pending")).toBeTruthy();

        expect(() => verifyToken(pending, "access")).toThrow();
        expect(() => verifyToken(access, "refresh")).toThrow();
        expect(() => verifyToken(refresh, "2fa-pending")).toThrow();
        expect(() => verifyToken(access, "2fa-pending")).toThrow();
    });

    it("records the authentication methods that were actually satisfied", () => {
        const passwordOnly = verifyToken<{ amr: string[] }>(signRefreshToken(7), "refresh");
        expect(passwordOnly.amr).toEqual(["pwd"]);

        const withOtp = verifyToken<{ amr: string[] }>(
            (() => {
                // Re-sign with the same helper the 2FA flow uses.
                const jwt = require("jsonwebtoken");
                return jwt.sign(
                    { userId: 7, amr: ["pwd", "otp"], purpose: "refresh" },
                    process.env.REFRESH_SECRET,
                    { expiresIn: "7d", issuer: "mindease", audience: "mindease:refresh" }
                );
            })(),
            "refresh"
        );
        expect(withOtp.amr).toContain("otp");
    });

    it("rejects a token with no purpose claim at all", () => {
        const jwt = require("jsonwebtoken");
        const purposeLess = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: "5m" });
        expect(() => verifyToken(purposeLess, "access")).toThrow();
    });
});

describe("Two-factor enforcement", () => {
    // Pinned so a code minted with the real clock cannot fall outside the
    // server's tolerance window while this test's Argon2 work runs. Without it
    // the failure surfaced far from its cause: `2fa/enable` returned 400,
    // `totpEnabled` stayed false, and the assertion below on `TOTP_REQUIRED`
    // failed instead. See `pinTwoFactorClock`.
    beforeEach(() => {
        pinTwoFactorClock();
    });
    afterEach(() => {
        unpinTwoFactorClock();
    });

    it("never authenticates a request without a completed second factor", async () => {
        const user = await createUser("patient");
        const setup = await user.agent.post("/api/account/2fa/setup").set("X-CSRF-Token", user.csrf);
        const secret = setup.body.data.secret;
        await user.agent
            .post("/api/account/2fa/enable")
            .set("X-CSRF-Token", user.csrf)
            .send({ code: speakeasy.totp({ secret, encoding: "base32" }) });

        // A token minted without the second factor is refused outright, even
        // though it is signed with the correct access-token secret.
        const incomplete = signAccessToken({ id: user.id, role: user.role, totpVerified: false });
        const res = await request(app)
            .get("/api/notifications")
            .set("Authorization", `Bearer ${incomplete}`);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe("TOTP_REQUIRED");
    });

    it("revokes existing sessions when 2FA is enabled", async () => {
        const user = await createUser("patient");
        const refreshToken = signRefreshToken(user.id);
        await prisma.refreshToken.create({
            data: {
                tokenHash: require("crypto").createHash("sha256").update(refreshToken).digest("hex"),
                userId: user.id,
                expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
            },
        });
        // Registration plus the extra token: more than one session exists.
        expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBeGreaterThan(1);

        const setup = await user.agent.post("/api/account/2fa/setup").set("X-CSRF-Token", user.csrf);
        await user.agent
            .post("/api/account/2fa/enable")
            .set("X-CSRF-Token", user.csrf)
            .send({ code: speakeasy.totp({ secret: setup.body.data.secret, encoding: "base32" }) });

        // A session established before 2FA existed must not survive it.
        expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
    });

    it("stores refresh tokens hashed, never in the clear", async () => {
        const user = await createUser("patient");
        const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
            // A JWT is three dot-separated base64 segments; a digest is not.
            expect(row.tokenHash).not.toContain(".");
        }
    });

    it("treats a replayed refresh token as theft and revokes the account", async () => {
        const user = await createUser("patient");
        const { AuthService } = await import("../src/services/auth.service");

        // A cryptographically valid token that the database has never seen is
        // the theft signal: it was already rotated, or it was stolen.
        const unknownButValid = signRefreshToken(user.id);
        await expect(AuthService.refresh(unknownButValid)).rejects.toThrow("Invalid Refresh Token");

        // Every session for the account is revoked.
        expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);

        // And it leaves an evidence trail.
        const audit = await prisma.auditLog.findFirst({
            where: { action: "auth.refresh_reuse_detected" },
        });
        expect(audit).toBeTruthy();
        expect(audit?.actorId).toBe(user.id);
    });

    it("rotates a refresh token and invalidates the previous one", async () => {
        const user = await createUser("patient");
        const { agent, csrf } = await setupClient();
        const login = await agent
            .post("/api/auth/login")
            .set("X-CSRF-Token", csrf)
            .send({ email: user.email, password: PASSWORD });
        expect(login.status).toBe(200);

        const original = readCookie(login, "refreshToken");
        expect(original).toBeTruthy();

        const first = await agent.post("/api/auth/refresh").set("X-CSRF-Token", csrf);
        expect(first.status).toBe(200);

        // The old token is no longer usable, and presenting it again is treated
        // as theft rather than as a benign race.
        const replay = await postWithCsrf("/api/auth/refresh", `refreshToken=${original}`);
        expect(replay.status).toBe(403);
        expect(await prisma.auditLog.count({ where: { action: "auth.refresh_reuse_detected" } })).toBe(1);
    });
});

describe("Account credential lifecycle", () => {
    it("revokes sessions on a password change", async () => {
        const user = await createUser("patient");
        expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBeGreaterThan(0);

        const res = await user.agent
            .post("/api/account/change-password")
            .set("X-CSRF-Token", user.csrf)
            .send({ currentPassword: PASSWORD, newPassword: "NewPass@4567" });
        expect(res.status).toBe(200);
        expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
    });

    it("revokes sessions on a password reset", async () => {
        const user = await createUser("patient");
        const otp = "654321";
        await prisma.user.update({
            where: { id: user.id },
            data: {
                resetOtpHash: await argon2.hash(otp),
                resetOtpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            },
        });

        const { agent, csrf } = await setupClient();
        const res = await agent
            .post("/api/account/reset-password")
            .set("X-CSRF-Token", csrf)
            .send({ email: user.email, otp, newPassword: "Reset@7890" });
        expect(res.status).toBe(200);
        expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
    });

    it("keeps the verification code and the reset code in separate slots", async () => {
        const user = await createUser("patient");
        const otp = "111222";
        const hash = await argon2.hash(otp);
        await prisma.user.update({
            where: { id: user.id },
            data: {
                resetOtpHash: hash,
                resetOtpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            },
        });

        // Requesting a verification code must not invalidate an in-flight reset.
        await user.agent
            .post("/api/account/resend-verification")
            .set("X-CSRF-Token", user.csrf)
            .send({ email: user.email });

        const after = await prisma.user.findUnique({
            where: { id: user.id },
            select: { resetOtpHash: true, verifyOtpHash: true },
        });
        expect(after?.resetOtpHash).toBeTruthy();
        expect(after?.verifyOtpHash).toBeTruthy();

        // And the reset code still works.
        const { agent, csrf } = await setupClient();
        const res = await agent
            .post("/api/account/reset-password")
            .set("X-CSRF-Token", csrf)
            .send({ email: user.email, otp, newPassword: "Reset@7890" });
        expect(res.status).toBe(200);
    });

    it("burns a reset code after too many wrong guesses", async () => {
        const user = await createUser("patient");
        await prisma.user.update({
            where: { id: user.id },
            data: {
                resetOtpHash: await argon2.hash("999888"),
                resetOtpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
                resetOtpAttempts: 5,
            },
        });

        const { agent, csrf } = await setupClient();
        const res = await agent
            .post("/api/account/reset-password")
            .set("X-CSRF-Token", csrf)
            .send({ email: user.email, otp: "000000", newPassword: "Reset@7890" });
        expect(res.status).toBe(400);

        const after = await prisma.user.findUnique({
            where: { id: user.id },
            select: { resetOtpHash: true },
        });
        expect(after?.resetOtpHash).toBeNull();
    });

    it("does not reveal whether an account exists on a reset request", async () => {
        const existing = await createUser("patient");
        const { agent, csrf } = await setupClient();
        const known = await agent
            .post("/api/account/forgot-password")
            .set("X-CSRF-Token", csrf)
            .send({ email: existing.email });
        const unknown = await agent
            .post("/api/account/forgot-password")
            .set("X-CSRF-Token", csrf)
            .send({ email: "nobody@nowhere.test" });
        expect(known.status).toBe(unknown.status);
        expect(known.body).toEqual(unknown.body);
    });
});

describe("Clinical data lifecycle", () => {
    it("purges pre-session disclosures when an account is deleted", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: doctor.doctorId,
                appointmentDate: localDay(new Date(Date.now() + 3 * 86400000)),
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
            });
        expect(book.status).toBe(201);

        const appointmentId = book.body.data.id;
        // Simulate the disclosure a patient would submit before a session.
        await prisma.preSessionData.create({
            data: {
                appointmentId,
                questionsJson: JSON.stringify(["How have you been feeling?"]),
                answersJson: JSON.stringify([
                    { question: "How have you been feeling?", answer: "I have been having dark thoughts." },
                ]),
                briefingText: "Patient disclosed intrusive thoughts of self-harm.",
            },
        });
        expect(await prisma.preSessionData.count({ where: { appointmentId } })).toBe(1);

        const admin = await createAdmin();
        const del = await patient.agent
            .delete("/api/account/me")
            .set("X-CSRF-Token", patient.csrf)
            .send({ password: PASSWORD });
        // Re-authentication is required to destroy a record this sensitive.
        expect(del.status).toBe(200);

        // The clinical disclosure and its derived briefing must be gone, even
        // though the appointment row is retained in anonymised form.
        expect(await prisma.preSessionData.count({ where: { appointmentId } })).toBe(0);
        const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
        expect(appointment?.notes).toBeNull();
        expect(admin).toBeTruthy();
    });

    it("requires password confirmation to delete an account", async () => {
        const user = await createUser("patient");
        const res = await user.agent.delete("/api/account/me").set("X-CSRF-Token", user.csrf).send({});
        expect(res.status).toBe(400);
        // Still there.
        expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeTruthy();
    });

    it("raises a risk alert for a PHQ-9 self-harm disclosure", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: doctor.doctorId,
                appointmentDate: localDay(new Date(Date.now() + 3 * 86400000)),
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
            });
        await doctor.agent
            .put(`/api/appointments/${book.body.data.id}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "confirmed" });

        // Item 9 answered "several days" (1) is still a disclosure.
        const answers = [0, 0, 0, 0, 0, 0, 0, 0, 1];
        const res = await patient.agent
            .post("/api/wellness/assessments")
            .set("X-CSRF-Token", patient.csrf)
            .send({ type: "phq9", answers });
        expect(res.status).toBe(201);

        expect(res.body.data.risk.riskFlag).toBe(true);
        expect(res.body.data.risk.level).toBe("elevated");
        expect(res.body.data.risk.hotlines.length).toBeGreaterThan(0);

        // The response must be able to say whether the disclosure was *recorded*,
        // separately from whether a clinician was reached. The two fail
        // independently - a connection pool exhausted by the crisis submission
        // itself is exactly the case where the clinician is notified and the
        // RiskAlert row is missing - and a client that cannot tell them apart
        // will show a patient a reassuring result screen for a disclosure that
        // left no audit trail.
        expect(res.body.data.risk.recorded).toBe(true);
        expect(res.body.data.risk.alertId).toBeTypeOf("number");

        const alert = await prisma.riskAlert.findFirst({ where: { userId: patient.id } });
        expect(alert).toBeTruthy();
        expect(alert?.level).toBe("elevated");
        expect(alert?.acknowledgedAt).toBeNull();
        expect(alert?.id).toBe(res.body.data.risk.alertId);
        // A clinician is attached, so the durable record names them.
        expect(alert?.notifiedDoctorUserId).toBe(doctor.id);

        // The clinician is told.
        const notifications = await doctor.agent.get("/api/notifications");
        expect(
            notifications.body.data.rows.some((n: { title: string }) => /risk disclosure/i.test(n.title))
        ).toBe(true);
    });

    it("does not raise an alert for a zero PHQ-9 item 9", async () => {
        const patient = await createUser("patient");
        const res = await patient.agent
            .post("/api/wellness/assessments")
            .set("X-CSRF-Token", patient.csrf)
            .send({ type: "phq9", answers: [3, 3, 2, 2, 1, 1, 2, 1, 0] });
        expect(res.status).toBe(201);
        expect(res.body.data.risk.riskFlag).toBe(false);
        // The no-risk signal still carries the full contract, so a client can
        // destructure it the same way it destructures a flagged one.
        expect(res.body.data.risk.clinicianNotified).toBe(false);
        expect(res.body.data.risk.recorded).toBe(true);
        expect(res.body.data.risk.alertId).toBeNull();
        expect(await prisma.riskAlert.count({ where: { userId: patient.id } })).toBe(0);
    });

    it("scopes the risk queue to a clinician's own patients", async () => {
        const patient = await createUser("patient");
        const mine = await createDoctor();
        const other = await createDoctor();
        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: mine.doctorId,
                appointmentDate: localDay(new Date(Date.now() + 3 * 86400000)),
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
            });
        await mine.agent
            .put(`/api/appointments/${book.body.data.id}/status`)
            .set("X-CSRF-Token", mine.csrf)
            .send({ status: "confirmed" });
        await patient.agent
            .post("/api/wellness/assessments")
            .set("X-CSRF-Token", patient.csrf)
            .send({ type: "phq9", answers: [0, 0, 0, 0, 0, 0, 0, 0, 3] });

        const visible = await mine.agent.get("/api/wellness/risk-alerts");
        expect(visible.status).toBe(200);
        expect(visible.body.data.length).toBe(1);

        // A clinician with no relationship to the patient sees nothing.
        const hidden = await other.agent.get("/api/wellness/risk-alerts");
        expect(hidden.body.data.length).toBe(0);
    });
});

describe("Appointment slot integrity", () => {
    const bookSlot = async (patient: Awaited<ReturnType<typeof createUser>>, doctorId: number, slotId: number) =>
        patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId,
                slotId,
                appointmentDate: localDay(new Date(Date.now() + 3 * 86400000)),
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
            });

    it("lets a cancelled slot be booked again", async () => {
        // Regression: cancelling set `isBooked = false` but left `slotId`
        // attached, and `Appointment.slotId` is unique — so every future
        // attempt to book that freed slot failed with a constraint error. The
        // waitlist emails patients to book exactly those slots.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const slot = await prisma.consultationSlot.create({
            data: {
                doctorId: doctor.doctorId,
                date: new Date(new Date().setHours(0, 0, 0, 0) + 3 * 86400000),
                startTime: "10:00",
                endTime: "11:00",
            },
        });

        const first = await bookSlot(patient, doctor.doctorId, slot.id);
        expect(first.status).toBe(201);

        const cancel = await patient.agent
            .put(`/api/appointments/${first.body.data.id}/status`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "cancelled" });
        expect(cancel.status).toBe(200);

        const freed = await prisma.consultationSlot.findUnique({ where: { id: slot.id } });
        expect(freed?.isBooked).toBe(false);

        // The whole point: the slot is genuinely bookable again.
        const second = await bookSlot(patient, doctor.doctorId, slot.id);
        expect(second.status).toBe(201);
        expect(second.body.data.id).not.toBe(first.body.data.id);
    });

    it("clears the reminder claim when an appointment is rescheduled", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: doctor.doctorId,
                appointmentDate: localDay(new Date(Date.now() + 3 * 86400000)),
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
            });
        await doctor.agent
            .put(`/api/appointments/${book.body.data.id}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "confirmed" });

        await prisma.appointment.update({
            where: { id: book.body.data.id },
            data: { reminderSentAt: new Date(), checkinSentAt: new Date() },
        });

        const res = await patient.agent
            .put(`/api/appointments/${book.body.data.id}/reschedule`)
            .set("X-CSRF-Token", patient.csrf)
            .send({
                appointmentDate: localDay(new Date(Date.now() + 5 * 86400000)),
                startTime: "14:00",
                endTime: "15:00",
            });
        expect(res.status).toBe(200);

        // Without this, the rescheduled session would never be reminded.
        const after = await prisma.appointment.findUnique({ where: { id: book.body.data.id } });
        expect(after?.reminderSentAt).toBeNull();
        expect(after?.checkinSentAt).toBeNull();
        expect(after?.status).toBe("pending");
    });

    it("discards the previous session's disclosure on reschedule", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: doctor.doctorId,
                appointmentDate: localDay(new Date(Date.now() + 3 * 86400000)),
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
            });
        const appointmentId = book.body.data.id;
        await doctor.agent
            .put(`/api/appointments/${appointmentId}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "confirmed" });
        await prisma.preSessionData.create({
            data: {
                appointmentId,
                answersJson: JSON.stringify([{ question: "q", answer: "a" }]),
                briefingText: "Briefing for the original date.",
            },
        });

        const res = await patient.agent
            .put(`/api/appointments/${appointmentId}/reschedule`)
            .set("X-CSRF-Token", patient.csrf)
            .send({
                appointmentDate: localDay(new Date(Date.now() + 5 * 86400000)),
                startTime: "14:00",
                endTime: "15:00",
            });
        expect(res.status).toBe(200);

        // A briefing written for the previous date must not survive.
        expect(await prisma.preSessionData.count({ where: { appointmentId } })).toBe(0);
    });
});

describe("Availability integrity", () => {
    const future = (days: number) => {
        const d = new Date();
        d.setDate(d.getDate() + days);
        d.setHours(0, 0, 0, 0);
        return d;
    };

    it("rejects a slot that overlaps an existing one", async () => {
        const doctor = await createDoctor();
        const first = await doctor.agent
            .post("/api/doctors/slots")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ date: localDay(future(4)), start_time: "10:00", end_time: "12:00" });
        expect(first.status).toBe(201);

        // 11:00–13:00 overlaps 10:00–12:00. A lexicographic comparison would
        // have accepted this, because "10:00" < "11:00" as a string but
        // 11:00 > 12:00 was never checked.
        const overlap = await doctor.agent
            .post("/api/doctors/slots")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ date: localDay(future(4)), start_time: "11:00", end_time: "13:00" });
        expect(overlap.status).toBe(400);

        // And 12:00–13:00 is a legitimate back-to-back booking.
        const adjacent = await doctor.agent
            .post("/api/doctors/slots")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ date: localDay(future(4)), start_time: "12:00", end_time: "13:00" });
        expect(adjacent.status).toBe(201);
    });

    it("rejects an exact duplicate slot at the database level", async () => {
        const doctor = await createDoctor();
        const payload = { date: localDay(future(5)), start_time: "14:00", end_time: "15:00" };
        expect(
            (await doctor.agent.post("/api/doctors/slots").set("X-CSRF-Token", doctor.csrf).send(payload))
                .status
        ).toBe(201);

        // Bypass the application check to prove the constraint exists.
        await expect(
            prisma.consultationSlot.create({
                data: {
                    doctorId: doctor.doctorId,
                    date: future(5),
                    startTime: "14:00",
                    endTime: "15:00",
                },
            })
        ).rejects.toThrow();
    });

    it("hides slots inside an away window and shows slots after it", async () => {
        const doctor = await createDoctor();
        const inside = await doctor.agent
            .post("/api/doctors/slots")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ date: localDay(future(4)), start_time: "10:00", end_time: "11:00" });
        const outside = await doctor.agent
            .post("/api/doctors/slots")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ date: localDay(future(9)), start_time: "10:00", end_time: "11:00" });
        expect(inside.status).toBe(201);
        expect(outside.status).toBe(201);

        const away = await doctor.agent
            .post("/api/doctors/away")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ awayUntil: localDay(future(6)) });
        expect(away.status).toBe(200);

        const slots = await doctor.agent.get(`/api/doctors/slots/${doctor.doctorId}`);
        // The comparison was inverted, which hid everything *before* the away
        // date and kept offering the slots inside the window.
        const listed = slots.body.data.map((s: { id: number }) => s.id);
        expect(listed).not.toContain(inside.body.data.id);
        expect(listed).toContain(outside.body.data.id);
    });

    it("keeps one waitlist row per doctor and patient", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        expect((await patient.agent.post(`/api/doctors/${doctor.doctorId}/waitlist`).set("X-CSRF-Token", patient.csrf)).status).toBe(201);
        // Re-joining is refused rather than creating a second row.
        const again = await patient.agent
            .post(`/api/doctors/${doctor.doctorId}/waitlist`)
            .set("X-CSRF-Token", patient.csrf);
        // 409 Conflict: the patient is already on this waitlist.
        expect(again.status).toBe(409);
        expect(await prisma.waitlistEntry.count({ where: { doctorId: doctor.doctorId, patientId: patient.id } })).toBe(1);
    });
});

describe("Public data exposure", () => {
    it("never returns contact details or hidden reviews on a public profile", async () => {
        const doctor = await createDoctor();
        const patient = await createUser("patient");
        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: doctor.doctorId,
                appointmentDate: localDay(new Date(Date.now() + 3 * 86400000)),
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
            });
        await doctor.agent
            .put(`/api/appointments/${book.body.data.id}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "confirmed" });
        await doctor.agent
            .put(`/api/appointments/${book.body.data.id}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "completed" });

        const review = await patient.agent
            .post("/api/reviews")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, appointmentId: book.body.data.id, rating: 1, comment: "A critical review" });
        expect(review.status).toBe(201);
        const reviewId = review.body.data.review.id;

        // An anonymous caller must not learn the clinician's contact details.
        const anon = await request(app).get(`/api/doctors/${doctor.doctorId}`);
        expect(anon.status).toBe(200);
        expect(anon.body.data.user.email).toBeUndefined();
        expect(anon.body.data.user.phone_number).toBeUndefined();

        // Moderation must be effective everywhere, not just on the dedicated
        // reviews endpoint.
        const admin = await createAdmin();
        await admin.agent.post(`/api/admin/reviews/${reviewId}/hide`).set("X-CSRF-Token", admin.csrf);

        const afterHide = await request(app).get(`/api/doctors/${doctor.doctorId}`);
        expect(afterHide.body.data.reviews.some((r: { id: number }) => r.id === reviewId)).toBe(false);
    });

    it("does not present a doctor with no reviews as a perfect 5.0", async () => {
        const doctor = await createDoctor();
        const anon = await request(app).get(`/api/doctors/${doctor.doctorId}`);
        expect(anon.status).toBe(200);
        expect(anon.body.data.totalReviews).toBe(0);
        expect(anon.body.data.rating).toBe(0);
    });

    it("keeps the API documentation out of reach of anonymous callers", async () => {
        const anon = await request(app).get("/api/docs/");
        // Either absent or gated; never a fully rendered specification.
        if (anon.status === 200) {
            expect(JSON.stringify(anon.body)).not.toContain("X-CSRF-Token");
        } else {
            expect([401, 403, 404]).toContain(anon.status);
        }
    });
});

describe("Input validation", () => {
    it("rejects an unparseable id instead of passing NaN to the database", async () => {
        const user = await createUser("patient");
        for (const bad of ["abc", "0", "-1", "1e999"]) {
            const res = await user.agent
                .get(`/api/wellness/journal/${bad}`)
                .set("X-CSRF-Token", user.csrf);
            expect([400, 404]).toContain(res.status);
            // A 500 would mean the NaN reached the driver.
            expect(res.status).not.toBe(500);
        }
    });

    it("rejects an unbounded history window", async () => {
        const user = await createUser("patient");
        for (const bad of ["99999999", "0", "-5", "abc"]) {
            const res = await user.agent.get(`/api/wellness/mood?days=${bad}`);
            expect(res.status).toBe(400);
        }
        expect((await user.agent.get("/api/wellness/mood?days=30")).status).toBe(200);
    });

    it("strips unknown keys instead of passing them to the handler", async () => {
        const user = await createUser("patient");
        const res = await user.agent
            .post("/api/wellness/mood")
            .set("X-CSRF-Token", user.csrf)
            .send({ mood: 3, role: "admin", isVerified: true, isBanned: false, sessionCredits: 999 });

        // The strict schema rejects the attempt outright rather than silently
        // dropping privileged fields.
        expect(res.status).toBe(400);
        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(after?.role).toBe("patient");
        expect(after?.sessionCredits).toBe(0);
    });

    it("cannot self-elevate a role or set a negative price", async () => {
        const doctor = await createDoctor();
        const escalate = await doctor.agent
            .put("/api/users/profile")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ role: "admin", isBanned: false });
        expect(escalate.status).toBe(400);
        const after = await prisma.user.findUnique({ where: { id: doctor.id } });
        expect(after?.role).toBe("doctor");

        const negative = await doctor.agent
            .put("/api/users/profile")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ price: -500 });
        expect(negative.status).toBe(400);
        const profile = await prisma.doctor.findUnique({ where: { id: doctor.doctorId } });
        expect(profile!.price).toBeGreaterThanOrEqual(0);
    });
});

describe("Error disclosure", () => {
    it("shows business messages and hides internal ones", () => {
        expect(publicMessageFor(new Error("This doctor is not accepting bookings yet"))).toEqual({
            message: "This doctor is not accepting bookings yet",
            status: 400,
        });
        expect(publicMessageFor(new Error("Forbidden: not your appointment"))?.status).toBe(403);
        expect(publicMessageFor(new Error("Journal entry not found"))?.status).toBe(404);

        // A Prisma error names models, columns and the offending argument.
        const prismaError = new Error(
            "Invalid `prisma.appointment.create()` invocation:\n\n{\n  data: { userId: 42 }\n}"
        );
        expect(publicMessageFor(prismaError)).toBeNull();

        expect(publicMessageFor(new Error("connect ECONNREFUSED 127.0.0.1:3306"))).toBeNull();
        expect(publicMessageFor(new Error("x".repeat(500)))).toBeNull();
        expect(publicMessageFor(new Error("SELECT * FROM User"))).toBeNull();
    });

    it("always discloses an explicit AppError", () => {
        const explicit = new AppError("Temporarily unavailable", 503);
        expect(publicMessageFor(explicit)).toEqual({
            message: "Temporarily unavailable",
            status: 503,
            details: undefined,
        });
    });

    it("does not leak a Prisma error body to the client", async () => {
        const user = await createUser("patient");
        // A body that violates the schema at the database layer.
        const res = await user.agent
            .post("/api/wellness/journal")
            .set("X-CSRF-Token", user.csrf)
            .send({ content: "x".repeat(20000) });
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).not.toContain("prisma");
        expect(JSON.stringify(res.body)).not.toContain("node_modules");
    });
});

describe("Timezone-correct day boundaries", () => {
    it("computes the same day key in a user's zone as in their locale", () => {
        // 2026-01-01T20:00Z is 2026-01-02 in Jakarta (UTC+7) and 2026-01-01 in
        // New York (UTC-5).
        const instant = new Date("2026-01-01T20:00:00.000Z");
        expect(dayKey(instant, "Asia/Jakarta")).toBe("2026-01-02");
        expect(dayKey(instant, "America/New_York")).toBe("2026-01-01");
    });

    it("resolves a zoned day boundary to the correct instant", () => {
        const start = startOfZonedDay("2026-06-15", "Asia/Jakarta");
        // Jakarta is UTC+7 with no daylight saving.
        expect(start.toISOString()).toBe("2026-06-14T17:00:00.000Z");

        // New York in June is UTC-4.
        const ny = startOfZonedDay("2026-06-15", "America/New_York");
        expect(ny.toISOString()).toBe("2026-06-15T04:00:00.000Z");
    });

    it("steps days across a month boundary", () => {
        expect(shiftDayKey("2026-03-01", -1, "UTC")).toBe("2026-02-28");
        expect(shiftDayKey("2026-02-28", 1, "UTC")).toBe("2026-03-01");
    });

    it("compares wall-clock times numerically, not lexicographically", () => {
        expect(timeToMinutes("9:00")).toBe(540);
        expect(timeToMinutes("10:00")).toBe(600);
        // The bug this guards: "10:00" < "9:00" is true as a string.
        expect(timeToMinutes("10:00") > timeToMinutes("9:00")).toBe(true);

        expect(overlaps(600, 720, 540, 660)).toBe(true); // 10:00-12:00 vs 9:00-11:00
        expect(overlaps(600, 720, 720, 780)).toBe(false); // back to back
        expect(overlaps(540, 600, 600, 660)).toBe(false); // adjacent, not overlapping
        expect(overlaps(600, 660, 540, 720)).toBe(true); // fully contained

        expect(Number.isNaN(timeToMinutes("nonsense"))).toBe(true);
        expect(Number.isNaN(timeToMinutes("25:00"))).toBe(true);
    });
});

describe("Mood logging invariants", () => {
    it("keeps one entry per calendar day under concurrent submission", async () => {
        const user = await createUser("patient");
        const payload = { mood: 4, notes: "Concurrent" };

        // Two simultaneous writes must not create two rows for the same day.
        await Promise.all([
            user.agent.post("/api/wellness/mood").set("X-CSRF-Token", user.csrf).send(payload),
            user.agent.post("/api/wellness/mood").set("X-CSRF-Token", user.csrf).send({ ...payload, mood: 2 }),
        ]);

        const rows = await prisma.moodEntry.findMany({ where: { userId: user.id } });
        expect(rows.length).toBe(1);
    });

    it("keys the day by the user's zone, not the server's", async () => {
        const user = await createUser("patient");
        await prisma.user.update({
            where: { id: user.id },
            data: { timezone: "America/New_York" },
        });
        await user.agent.post("/api/wellness/mood").set("X-CSRF-Token", user.csrf).send({ mood: 3 });

        const row = await prisma.moodEntry.findFirst({ where: { userId: user.id } });
        expect(row?.moodDate).toBe(dayKey(new Date(), "America/New_York"));
    });
});
