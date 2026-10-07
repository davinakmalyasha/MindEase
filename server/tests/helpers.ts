import request from "supertest";
import argon2 from "argon2";
import { createApp } from "../src/app";
import { prisma } from "../src/app";
import { TwoFactorService } from "../src/services/twoFactor.service";

export const app = createApp();

export const PASSWORD = "TestPass@123";

/**
 * The access token is delivered only as an HttpOnly cookie — it is deliberately
 * no longer part of the JSON body, because returning it there makes it readable
 * by any script on the page and defeats the point of the cookie. Tests read it
 * back out of the cookie jar instead, which is also what a browser does.
 */
export const accessTokenFrom = (res: request.Response): string => {
    const cookies = res.headers["set-cookie"];
    if (!Array.isArray(cookies)) return "";
    for (const cookie of cookies) {
        const match = /^accessToken=([^;]*)/.exec(cookie);
        if (match) return decodeURIComponent(match[1]);
    }
    return "";
};

export interface TestUser {
    email: string;
    password: string;
    role: string;
    id: number;
    accessToken: string;
    agent: request.SuperAgentTest;
    csrf: string;
}

// A shared agent carrying the CSRF cookie, plus the matching header value
export const setupClient = async () => {
    const agent = request.agent(app);
    const res = await agent.get("/api/csrf-token");
    return { agent, csrf: res.body.data.csrfToken };
};

export const createUser = async (role: string, email?: string): Promise<TestUser> => {
    const mail = email || `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.app`;
    const { agent, csrf } = await setupClient();
    const res = await agent
        .post("/api/auth/register")
        .set("X-CSRF-Token", csrf)
        .send({ email: mail, password: PASSWORD, name: `Test ${role}`, role, phone_number: "+6281234567890" });
    if (res.status !== 201) {
        throw new Error(`Failed to create ${role} user: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return {
        email: mail,
        password: PASSWORD,
        role,
        id: res.body.data.user.id,
        accessToken: accessTokenFrom(res),
        agent,
        csrf,
    };
};

export const createDoctor = async (email?: string, opts?: { verified?: boolean }) => {
    const user = await createUser("doctor", email);
    const doctor = await prisma.doctor.findUnique({ where: { userId: user.id } });
    if (!doctor) throw new Error("Doctor profile not created");
    // Booking requires an approved doctor — approve by default so test flows
    // can book; pass { verified: false } to test the pending state.
    if (opts?.verified !== false) {
        await prisma.doctor.update({ where: { id: doctor.id }, data: { verificationStatus: "approved" } });
    }
    return { ...user, doctorId: doctor.id };
};

export const createAdmin = async () => {
    const email = `admin-${Date.now()}@test.app`;
    const hashed = await argon2.hash(PASSWORD);
    await prisma.user.create({
        data: { email, password: hashed, name: "Test Admin", role: "admin", isVerified: true },
    });
    const { agent, csrf } = await setupClient();
    const res = await agent
        .post("/api/auth/login")
        .set("X-CSRF-Token", csrf)
        .send({ email, password: PASSWORD });
    return {
        email,
        password: PASSWORD,
        role: "admin",
        id: res.body.data.user.id,
        accessToken: accessTokenFrom(res),
        agent,
        csrf,
    };
};

export const withAuth = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Pins the two-factor service's clock to the middle of the *current* 30-second
 * TOTP step.
 *
 * A TOTP code is only a function of a time step, and the +/- 1 step tolerance
 * is the only buffer between a client minting a code and the server checking
 * it. These tests mint with `speakeasy.totp()` (real time) and then issue an
 * HTTP request whose Argon2 work can, on a loaded machine, take longer than a
 * whole step. When that happened `2fa/enable` returned 400, `totpEnabled` was
 * never set, and the failure surfaced as an unrelated assertion about
 * `TOTP_REQUIRED` further down.
 *
 * Pinning to the middle of the live step keeps every assertion inside the
 * window a real authenticator satisfies, and removes the timing dependency
 * without weakening what is actually tested: the tolerance, the replay guard
 * and the session behaviour are all unchanged.
 *
 * Always pair with `unpinTwoFactorClock()`.
 */
export const pinTwoFactorClock = () => {
    const now = Date.now();
    TwoFactorService.__pinNow(now);
    return now;
};

export const unpinTwoFactorClock = () => {
    TwoFactorService.__pinNow(null);
};

/** Seeds a mood entry with the timezone-aware day key the schema now requires. */
export const createMoodEntry = (
    userId: number,
    mood: number,
    createdAt: Date,
    extra: Record<string, unknown> = {}
) => {
    // Matches the default user zone used by the application.
    const wib = new Date(createdAt.getTime() + 7 * 60 * 60 * 1000);
    const moodDate = `${wib.getUTCFullYear()}-${String(wib.getUTCMonth() + 1).padStart(2, "0")}-${String(
        wib.getUTCDate()
    ).padStart(2, "0")}`;
    return prisma.moodEntry.create({
        data: { userId, mood, createdAt, moodDate, ...extra } as never,
    });
};

/**
 * Creates a package entitlement the way the payment provider will once wired:
 * a purchase with a verified `paidAt`.
 *
 * A patient-facing self-service purchase is deliberately refused (it used to
 * mint unlimited free therapy packages), so tests that need to exercise booking
 * against a package must go through this path.
 */
export const grantPaidPackage = async (userId: number, packageId: number) => {
    const pkg = await prisma.package.findUnique({
        where: { id: packageId },
        select: { sessionCount: true },
    });
    if (!pkg) throw new Error("Package not found");
    return prisma.packagePurchase.create({
        data: { userId, packageId, sessionsLeft: pkg.sessionCount, paidAt: new Date() },
    });
};
