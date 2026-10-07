/**
 * `/api/health/db` checks the schema, not only the connection.
 *
 * It used to run `SELECT 1`, which proves MySQL is reachable and says nothing
 * about whether the schema matches what this process was built against. The
 * failure that could not be seen is the one that actually happens on a deploy:
 * the migration step does not run, the API boots, the liveness probe goes green,
 * and the first request that touches a new column returns a 500 - discovered by a
 * user rather than by the health check that exists to be asked.
 *
 * The models come from the generated Prisma client, so the check compares the
 * database against what *this build* expects rather than against a second
 * hand-maintained list.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { app } from "./helpers";
import { prisma } from "../src/app";

const MODEL_COUNT = Prisma.dmmf.datamodel.models.length;

describe("/api/health/db", () => {
    it("reports ok with the table count when the schema matches", async () => {
        const res = await request(app).get("/api/health/db");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
        expect(res.body.db).toBe("connected");
        expect(res.body.schema).toBe("ok");
        expect(res.body.tables).toBe(MODEL_COUNT);
    });

    it("fails with a drift status when a table is missing", async () => {
        // Actually drop a table rather than mocking the check. A mocked database
        // layer proves the branch runs; it does not prove the branch is reachable
        // from a real drifted schema, which is the whole failure being guarded.
        //
        // `JobLock` is the table to borrow: nothing else in this test file touches
        // it, it carries no foreign keys pointing at it, and it is recreated by
        // `prisma migrate deploy` on the next run.
        await prisma.$executeRawUnsafe("DROP TABLE IF EXISTS `JobLock`");

        try {
            const res = await request(app).get("/api/health/db");

            expect(res.status).toBe(503);
            expect(res.body.status).toBe("error");
            // It reached the database, so the failure is specifically the schema.
            expect(res.body.db).toBe("reachable");
            expect(res.body.schema).toBe("drift");
            expect(res.body.missingCount).toBe(1);
            // And the names are not handed to an unauthenticated caller.
            expect(JSON.stringify(res.body)).not.toContain("JobLock");
        } finally {
            // Recreate it by re-applying the migration's own DDL, read from the
            // file rather than copied into this test. A hand-written CREATE would
            // be a second definition of the table that can drift from the first,
            // and the drift would surface as a schema-drift failure in a later CI
            // run with nothing pointing back here.
            //
            // `migrate deploy` would also fix this on the next run, but a test
            // that leaves the schema drifted breaks whichever suite runs next.
            const sql = fs
                .readFileSync(
                    path.join(__dirname, "..", "prisma", "migrations", "20261004000000_job_lock", "migration.sql"),
                    "utf8"
                )
                .split("\n")
                .filter((line) => !line.trim().startsWith("--"))
                .join("\n");
            for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
                await prisma.$executeRawUnsafe(statement);
            }
        }
    });
});
