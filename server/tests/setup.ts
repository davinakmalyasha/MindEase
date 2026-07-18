const testDbUrl = process.env.TEST_DATABASE_URL || "mysql://root:@localhost:3306/mindease_test";
process.env.DATABASE_URL = testDbUrl;
process.env.JWT_SECRET = "test-jwt-secret";
process.env.REFRESH_SECRET = "test-refresh-secret";
process.env.NODE_ENV = "test";

import { afterEach, beforeEach } from "vitest";
import { prisma } from "../src/app";

const TABLES = [
    "AuditLog",
    "RefreshToken",
    "PreSessionData",
    "Review",
    "Message",
    "Notification",
    "MoodEntry",
    "ConsultationSlot",
    "Appointment",
    "Doctor",
    "User",
];

beforeEach(async () => {
    await prisma.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of TABLES) {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``);
    }
    await prisma.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
});

afterEach(async () => {
    await prisma.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of TABLES) {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``);
    }
    await prisma.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
});
