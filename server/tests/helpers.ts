import request from "supertest";
import argon2 from "argon2";
import { createApp } from "../src/app";
import { prisma } from "../src/app";

export const app = createApp();

export const PASSWORD = "TestPass@123";

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
        accessToken: res.body.data.accessToken,
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
        accessToken: res.body.data.accessToken,
        agent,
        csrf,
    };
};

export const withAuth = (token: string) => ({ Authorization: `Bearer ${token}` });
