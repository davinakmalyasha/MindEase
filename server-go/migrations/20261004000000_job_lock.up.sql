-- A single-runner gate for the scheduled jobs.
--
-- Replaces MySQL's `GET_LOCK` as the no-Redis fallback in `lib/cache.ts`.
-- `GET_LOCK` is scoped to the connection and Prisma borrows connections from a
-- pool, so the lock leaked: taken on one connection, held after that connection
-- returned to the pool, and released with `RELEASE_LOCK` on a different borrowed
-- connection where it is a no-op. The code carried a comment admitting it "cannot
-- work as written" and shipped it anyway.
--
-- A row with a unique key is the same idea in a form a connection pool cannot
-- break. Acquisition is a conditional UPDATE, which is atomic, holds nothing
-- open, and clears by expiry - so a crashed runner does not wedge the job
-- permanently.

CREATE TABLE `JobLock` (
    `key` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `JobLock_expiresAt_idx` (`expiresAt`),
    PRIMARY KEY (`key`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
