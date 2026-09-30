const testDbUrl = process.env.TEST_DATABASE_URL || "mysql://root:@127.0.0.1:3306/mindease_test";
process.env.DATABASE_URL = testDbUrl;
process.env.JWT_SECRET = "test-jwt-secret-value-0001";
process.env.REFRESH_SECRET = "test-refresh-secret-0001";
process.env.TWO_FACTOR_SECRET = "test-two-factor-secret-0001";
process.env.NODE_ENV = "test";

import { afterEach, beforeEach } from "vitest";
import { prisma } from "../src/app";
import { Prisma } from "@prisma/client";

/**
 * Every model, read from the generated Prisma client rather than listed by hand.
 *
 * This was a hand-maintained array of 22 names and it had already fallen behind
 * the schema: `PaymentOrder` was added and never added here. The failure is
 * quiet - foreign key checks are disabled for the wipe, so a table that is
 * skipped is not an error, it is an orphan row that survives into the next test
 * and surfaces much later as a count that is one too high, or a unique-constraint
 * failure in an unrelated case.
 *
 * Deriving it means a new model is wiped the day it is created, because
 * `prisma generate` runs before the suite.
 */
const TABLES = Prisma.dmmf.datamodel.models.map((model) => model.name);

// Sanity check: a silently empty list would turn `wipeDb` into a no-op that
// leaves every test running against the previous test's data, which is far worse
// than a loud failure. Assert rather than trust.
if (TABLES.length === 0) {
    throw new Error(
        "wipeDb: Prisma.dmmf.datamodel.models is empty. The client was not generated " +
            "(run `npx prisma generate`), so the database is not being reset between tests."
    );
}

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
