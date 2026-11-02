-- Between-session care: safety loop, measurement and homework support.
--
-- Lane A (safety loop): RiskAlert gains followUpDueAt + outcome so resolving
-- records what was done and when the patient is owed a check-in, instead of a
-- free-text note that cannot be queried. User gains nudge sentinels for stale
-- assessments and stale safety-plan reviews; both are claim columns like the
-- existing mood nudges, not timestamps of record.
--
-- Lane B (measurement): no schema change; PHQ-2/GAD-7 reuse Assessment.type.
-- The stale-assessment sentinel above is the only column this lane needs.
--
-- Lane C (between-session): ThoughtRecord stores a CBT thought record as
-- separate columns (not JSON) so a clinician can read one field without
-- parsing prose; SessionFeedback stores the 4-item alliance (SRS) per
-- completed appointment, unique per appointment; Consent stores per-purpose
-- opt-ins (ai-read first) so AI use is a recorded choice, not a default.
-- CareStep gains dueDate for homework with a deadline; CareGoal gains barrier
-- so a dropped goal keeps why it was wrong; CarePlan gains relapse fields so
-- closure leaves a plan for what to watch for, not just a status.
ALTER TABLE `RiskAlert`
    ADD COLUMN `followUpDueAt` DATETIME(3) NULL,
    ADD COLUMN `outcome` VARCHAR(32) NULL;

CREATE INDEX `RiskAlert_followUpDueAt_idx` ON `RiskAlert`(`followUpDueAt`);
CREATE INDEX `RiskAlert_outcome_idx` ON `RiskAlert`(`outcome`);

ALTER TABLE `User`
    ADD COLUMN `lastAssessmentNudgeAt` DATETIME(3) NULL,
    ADD COLUMN `lastSafetyReviewNudgeAt` DATETIME(3) NULL,
    ADD COLUMN `aiReadConsent` BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX `User_role_lastAssessmentNudgeAt_idx` ON `User`(`role`, `lastAssessmentNudgeAt`);

ALTER TABLE `CareGoal`
    ADD COLUMN `barrier` TEXT NULL;

ALTER TABLE `CareStep`
    ADD COLUMN `dueDate` DATETIME(3) NULL;

CREATE INDEX `CareStep_dueDate_idx` ON `CareStep`(`dueDate`);

ALTER TABLE `CarePlan`
    ADD COLUMN `relapseSummary` TEXT NULL,
    ADD COLUMN `earlyWarnings` TEXT NULL,
    ADD COLUMN `supportContacts` TEXT NULL;

-- CBT thought record: one row per exercise. Columns, not JSON, because each
-- field is read and written as a unit and a clinician reviewing progress
-- reads one field at a time. moodBefore/moodAfter are 1-5 like MoodEntry.
CREATE TABLE `ThoughtRecord` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `situation` TEXT NOT NULL,
    `thought` TEXT NOT NULL,
    `evidenceFor` TEXT NULL,
    `evidenceAgainst` TEXT NULL,
    `balanced` TEXT NULL,
    `moodBefore` INTEGER NULL,
    `moodAfter` INTEGER NULL,
    `careGoalId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ThoughtRecord_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Session alliance (SRS): 4 items, each 0-10. Unique per appointment so a
-- completed session gets exactly one alliance score, like Review.
CREATE TABLE `SessionFeedback` (
    `id` CHAR(36) NOT NULL,
    `appointmentId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `doctorId` CHAR(36) NOT NULL,
    `listening` INTEGER NOT NULL,
    `goals` INTEGER NOT NULL,
    `approach` INTEGER NOT NULL,
    `overall` INTEGER NOT NULL,
    `comment` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SessionFeedback_appointmentId_key`(`appointmentId`),
    INDEX `SessionFeedback_doctorId_idx`(`doctorId`),
    INDEX `SessionFeedback_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Per-purpose consent ledger. ai-read is first; data-share follows the same
-- shape. One row per (user, purpose) so granting and revoking are updates,
-- not deletes, and the history survives in AuditLog.
CREATE TABLE `Consent` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `purpose` VARCHAR(64) NOT NULL,
    `granted` BOOLEAN NOT NULL DEFAULT false,
    `grantedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Consent_userId_purpose_key`(`userId`, `purpose`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
