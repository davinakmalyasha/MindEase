-- Clinical continuity: a care plan that outlives a session, and a patient-owned
-- safety plan.
--
-- Three groups of changes, ordered so the datamodel and the database never
-- disagree at an intermediate point: a behaviour change to RiskAlert, the three
-- care-plan models, then SafetyPlan.
--
-- Two corrections were made to this file after it was first written, and both
-- were found by the `prisma migrate diff --exit-code` gate in CI rather than by
-- a test. Both are edited in place rather than added as a follow-up migration,
-- because this file has never been applied anywhere persistent: the feature
-- branch was never pushed and no deploy has run. Correcting it in place is what
-- leaves a single honest source of truth for how the schema is built.
--
--   1. `resolvedById` was missing. The datamodel declared it and
--      `riskQueue.service.ts` wrote it, but no statement here created the
--      column, so against a `migrate deploy` database every queue read and
--      every resolve threw a PrismaClientValidationError. A test that never
--      ran against a migrated database is how that survived.
--   2. `CarePlan.userId` had no foreign key. SafetyPlan below got one, CarePlan
--      did not, and Prisma's drift gate reported the omission on every run.

-- ---------------------------------------------------------------------------
-- 1. RiskAlert becomes a worklist rather than a log.
-- ---------------------------------------------------------------------------
--
-- Acknowledging and resolving are different acts. `acknowledgedAt` means
-- "somebody has seen this"; `resolvedAt` means "this is dealt with". Before
-- this, the queue could express the first and not the second, so an alert a
-- clinician had looked at on Monday and still needed to act on Friday looked
-- identical to one they had never seen.
--
-- `resolvedAt` NULL is the queue filter, so the index leads with it.
ALTER TABLE `RiskAlert`
    ADD COLUMN `resolvedAt` DATETIME(3) NULL,
    ADD COLUMN `resolutionNote` TEXT NULL,
    ADD COLUMN `assignedDoctorUserId` INTEGER NULL,
    ADD COLUMN `resolvedById` INTEGER NULL;

-- Deliberately NOT a foreign key, matching `acknowledgedById` and
-- `notifiedDoctorUserId` on this table. Those are actor references that must
-- outlive the actor: an account deletion anonymises the user rather than
-- removing the row, and a real FK would either block that or cascade away the
-- clinical record. `account.service.ts` documents the same decision for the
-- RiskAlert rows themselves.
--
-- `assignedDoctorUserId` is separate from `notifiedDoctorUserId` on purpose.
-- Several channels fire at once - in-app, email, realtime, WhatsApp, and up to
-- five admins - so "who was told" is often not a clinician at all. The queue
-- has to be addressed to whoever is actually treating the patient, or an alert
-- raised at 23:00 lands in nobody's worklist.
CREATE INDEX `RiskAlert_assignedDoctorUserId_resolvedAt_createdAt_idx`
    ON `RiskAlert`(`assignedDoctorUserId`, `resolvedAt`, `createdAt`);

-- ---------------------------------------------------------------------------
-- 2. CarePlan / CareGoal / CareStep.
-- ---------------------------------------------------------------------------
CREATE TABLE `CarePlan` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `doctorUserId` INTEGER NULL,
    `title` VARCHAR(160) NOT NULL DEFAULT 'My care plan',
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `summary` TEXT NULL,
    `reviewAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CarePlan_userId_status_idx`(`userId`, `status`),
    INDEX `CarePlan_doctorUserId_idx`(`doctorUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- `doctorUserId` is not a foreign key for the same reason as
-- `RiskAlert.assignedDoctorUserId`. A clinician leaving the platform must not
-- delete a patient's plan, and a plan outliving its clinician is the normal
-- case rather than an error.
--
-- `userId` IS a foreign key, and the absence of one here was a real omission
-- rather than a decision: an orphaned plan is unreadable by design
-- (`carePlan.service.ts` keys every read off the owner) but nothing at the
-- database level prevented a row pointing at a deleted user. SafetyPlan below
-- cascades for the same reason, so the two behave consistently.
ALTER TABLE `CarePlan`
    ADD CONSTRAINT `CarePlan_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `CareGoal` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `carePlanId` INTEGER NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `detail` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `targetDate` DATETIME(3) NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CareGoal_carePlanId_order_idx`(`carePlanId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CareStep` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `careGoalId` INTEGER NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `done` BOOLEAN NOT NULL DEFAULT false,
    `doneAt` DATETIME(3) NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CareStep_careGoalId_order_idx`(`careGoalId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Cascade from the plan rather than restricting: a plan with no goals is not a
-- plan, and the ownership check for goals is always reached through their plan.
ALTER TABLE `CareGoal`
    ADD CONSTRAINT `CareGoal_carePlanId_fkey`
    FOREIGN KEY (`carePlanId`) REFERENCES `CarePlan`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CareStep`
    ADD CONSTRAINT `CareStep_careGoalId_fkey`
    FOREIGN KEY (`careGoalId`) REFERENCES `CareGoal`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. SafetyPlan.
-- ---------------------------------------------------------------------------
CREATE TABLE `SafetyPlan` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `warningSigns` TEXT NULL,
    `copingStrategies` TEXT NULL,
    `reasonsToLive` TEXT NULL,
    `contacts` TEXT NULL,
    `professionalContact` VARCHAR(255) NULL,
    `locationToBeSafe` VARCHAR(255) NULL,
    `lastReviewedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SafetyPlan_userId_key`(`userId`),
    INDEX `SafetyPlan_lastReviewedAt_idx`(`lastReviewedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SafetyPlan`
    ADD CONSTRAINT `SafetyPlan_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
