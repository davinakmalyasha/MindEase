const testDbUrl = process.env.TEST_DATABASE_URL || "mysql://root:@127.0.0.1:3306/mindease_test";
process.env.DATABASE_URL = testDbUrl;
process.env.JWT_SECRET = "test-jwt-secret-value-0001";
process.env.REFRESH_SECRET = "test-refresh-secret-0001";
process.env.TWO_FACTOR_SECRET = "test-two-factor-secret-0001";
process.env.NODE_ENV = "test";

import { afterEach, beforeEach } from "vitest";
import { prisma } from "../src/app";

const TABLES = [
    "AuditLog",
    "RiskAlert",
    "RefreshToken",
    "PreSessionData",
    "ReviewReport",
    "Review",
    "Message",
    "Notification",
    "MoodEntry",
    "JournalEntry",
    "Assessment",
    "ConsultationSlot",
    "AvailabilityPattern",
    "FollowUp",
    "WaitlistEntry",
    "PackagePurchase",
    "Package",
    "PushSubscription",
    "Referral",
    "Appointment",
    "Doctor",
    "User",
];

// Runs on a single connection (interactive transaction). DELETE is used
// instead of TRUNCATE because TRUNCATE implicitly commits — which would
// terminate the transaction mid-way — and because FK checks are disabled
// per-session, so all statements must share one connection.
const wipeDb = async () => {
    await prisma.$transaction(
        async (tx) => {
            await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
            for (const table of TABLES) {
                await tx.$executeRawUnsafe(`DELETE FROM \`${table}\``);
            }
            await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
        },
        { maxWait: 15000, timeout: 60000 }
    );
};

beforeEach(wipeDb);
afterEach(wipeDb);
