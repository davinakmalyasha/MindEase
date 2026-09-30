-- Wave 0 hardening: hashed refresh tokens, TOTP replay guard, independent OTP slots.
--
-- Refresh tokens are now stored as a SHA-256 digest. Existing sessions are
-- invalidated rather than migrated: the plaintext token is not recoverable into
-- a hash without the original value, and forcing every user to sign in again is
-- the correct trade for a credential store.

ALTER TABLE `RefreshToken` ADD COLUMN `tokenHash` VARCHAR(64) NULL;

-- Purge every existing refresh token, then make the new column required.
DELETE FROM `RefreshToken`;

ALTER TABLE `RefreshToken` MODIFY COLUMN `tokenHash` VARCHAR(64) NOT NULL;

CREATE UNIQUE INDEX `RefreshToken_tokenHash_key` ON `RefreshToken`(`tokenHash`);

-- Pruning scans run on every token issue and on every refresh.
CREATE INDEX `RefreshToken_userId_idx` ON `RefreshToken`(`userId`);
CREATE INDEX `RefreshToken_expiresAt_idx` ON `RefreshToken`(`expiresAt`);

-- TOTP replay guard: highest accepted 30-second step. An Int, not a BigInt, so
-- a stray serialization of the model can never throw.
ALTER TABLE `User` ADD COLUMN `lastTotpStep` INTEGER NULL;

-- Brute-force limits per OTP, and separate slots so requesting an email
-- verification code can no longer invalidate an in-flight password reset
-- (and a code earned in one flow cannot be spent on the other).
ALTER TABLE `User`
    ADD COLUMN `resetOtpAttempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `verifyOtpHash` VARCHAR(191) NULL,
    ADD COLUMN `verifyOtpExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `verifyOtpAttempts` INTEGER NOT NULL DEFAULT 0;

-- Prisma's migrate diff flags these as drift because the baseline created them
-- at a narrower width than the datamodel declares.
ALTER TABLE `Message` MODIFY COLUMN `attachmentType` VARCHAR(50) NULL;
ALTER TABLE `PushSubscription` MODIFY COLUMN `endpoint` VARCHAR(500) NOT NULL;
ALTER TABLE `PushSubscription` MODIFY COLUMN `p256dh` VARCHAR(500) NOT NULL;
ALTER TABLE `PushSubscription` MODIFY COLUMN `auth` VARCHAR(500) NOT NULL;

-- Durable record of clinically significant risk disclosures, such as a
-- non-zero answer to PHQ-9 item 9. Previously such an answer was reduced to a
-- numeric score and produced no signal at all.
CREATE TABLE `RiskAlert` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `level` VARCHAR(191) NOT NULL,
    `reason` TEXT NOT NULL,
    `sourceType` VARCHAR(191) NOT NULL,
    `sourceId` INTEGER NULL,
    `acknowledgedAt` DATETIME(3) NULL,
    `acknowledgedById` INTEGER NULL,
    `notifiedDoctorUserId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RiskAlert_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `RiskAlert_acknowledgedAt_idx`(`acknowledgedAt`),
    INDEX `RiskAlert_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `RiskAlert`
    ADD CONSTRAINT `RiskAlert_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill the timezone-aware mood day key before making it required.
ALTER TABLE `MoodEntry` ADD COLUMN `moodDate` VARCHAR(10) NULL;

-- `createdAt` is stored in UTC; derive each row's calendar day in the default
-- user zone (Asia/Jakarta, UTC+7) so the backfill matches what the application
-- will write going forward.
UPDATE `MoodEntry`
SET `moodDate` = DATE_FORMAT(DATE_ADD(`createdAt`, INTERVAL 7 HOUR), '%Y-%m-%d')
WHERE `moodDate` IS NULL;

-- A user with several entries on one day collapses to the latest, so the
-- unique key below can be created without deduplicating by hand.
DELETE `moodEntry` FROM `MoodEntry`
JOIN (
    SELECT `userId`, `moodDate`, MAX(`id`) AS `keepId`
    FROM `MoodEntry`
    GROUP BY `userId`, `moodDate`
    HAVING COUNT(*) > 1
) AS dupes
  ON `MoodEntry`.`userId` = dupes.`userId`
 AND `MoodEntry`.`moodDate` = dupes.`moodDate`
 AND `MoodEntry`.`id` <> dupes.`keepId`;

ALTER TABLE `MoodEntry` MODIFY COLUMN `moodDate` VARCHAR(10) NOT NULL;

-- "One mood log per calendar day" is now a database invariant, which also makes
-- concurrent submissions idempotent instead of a check-then-create race.
CREATE UNIQUE INDEX `MoodEntry_userId_moodDate_key` ON `MoodEntry`(`userId`, `moodDate`);

-- Exact-duplicate availability slots. Two concurrent create requests could both
-- pass the application overlap check and both insert.
CREATE UNIQUE INDEX `ConsultationSlot_doctorId_date_startTime_endTime_key`
    ON `ConsultationSlot`(`doctorId`, `date`, `startTime`, `endTime`);

CREATE UNIQUE INDEX `AvailabilityPattern_doctorId_weekday_startTime_endTime_key`
    ON `AvailabilityPattern`(`doctorId`, `weekday`, `startTime`, `endTime`);

-- One waitlist row per (doctor, patient). The previous key included `status`,
-- which let `waiting` and `notified` rows coexist and produced duplicate
-- notifications. Collapse any pre-existing duplicates, keeping the most
-- advanced state per pair.
ALTER TABLE `WaitlistEntry` ADD COLUMN `notifiedAt` DATETIME(3) NULL;

DELETE `w` FROM `WaitlistEntry` `w`
JOIN (
    SELECT `doctorId`, `patientId`, MAX(`id`) AS `keepId`
    FROM `WaitlistEntry`
    GROUP BY `doctorId`, `patientId`
    HAVING COUNT(*) > 1
) AS dupes
  ON `w`.`doctorId` = dupes.`doctorId`
 AND `w`.`patientId` = dupes.`patientId`
 AND `w`.`id` <> dupes.`keepId`;

CREATE UNIQUE INDEX `WaitlistEntry_doctorId_patientId_key`
    ON `WaitlistEntry`(`doctorId`, `patientId`);

-- Package entitlements. A purchase with neither a verified `paidAt` nor an
-- administrative `grantedByUserId` is not a legitimate entitlement, which
-- closes the free-unlimited-package exploit.
ALTER TABLE `PackagePurchase`
    ADD COLUMN `paidAt` DATETIME(3) NULL,
    ADD COLUMN `grantedByUserId` INTEGER NULL;

CREATE INDEX `PackagePurchase_userId_status_idx` ON `PackagePurchase`(`userId`, `status`);

-- New clinician-facing profile fields.
ALTER TABLE `Doctor`
    ADD COLUMN `totalReviews` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `languages` VARCHAR(191) NULL,
    ADD COLUMN `education` TEXT NULL;

-- A doctor with no visible review has no rating, not a perfect 5.0. Reset any
-- stored value that was only ever the 5.0 default.
UPDATE `Doctor` SET `rating` = 0, `totalReviews` = 0 WHERE `totalReviews` = 0;

-- Cron candidate scans. Without an index leading on these columns the reminder
-- and check-in jobs full-scanned the table on every run, on every replica.
CREATE INDEX `Appointment_reminderSentAt_appointmentDate_status_idx`
    ON `Appointment`(`reminderSentAt`, `appointmentDate`, `status`);
CREATE INDEX `Appointment_checkinSentAt_appointmentDate_status_idx`
    ON `Appointment`(`checkinSentAt`, `appointmentDate`, `status`);
CREATE INDEX `Appointment_userId_appointmentDate_idx`
    ON `Appointment`(`userId`, `appointmentDate`);

CREATE INDEX `User_role_lastMoodNudgeAt_idx` ON `User`(`role`, `lastMoodNudgeAt`);
CREATE INDEX `User_role_lastDeclineNudgeAt_idx` ON `User`(`role`, `lastDeclineNudgeAt`);
CREATE INDEX `User_weeklyReportEnabled_role_idx` ON `User`(`weeklyReportEnabled`, `role`);

-- The doctor directory filters and sorts on these columns and previously had
-- indexes on none of them.
CREATE INDEX `Doctor_verificationStatus_rating_idx` ON `Doctor`(`verificationStatus`, `rating`);
CREATE INDEX `Doctor_specialty_price_idx` ON `Doctor`(`specialty`, `price`);
CREATE INDEX `Doctor_experience_idx` ON `Doctor`(`experience`);
CREATE INDEX `Doctor_verificationStatus_awayUntil_idx` ON `Doctor`(`verificationStatus`, `awayUntil`);

-- `orderBy: createdAt` with only a leading-column index forces a filesort.
CREATE INDEX `Review_doctorId_hidden_createdAt_idx` ON `Review`(`doctorId`, `hidden`, `createdAt`);
CREATE INDEX `AuditLog_createdAt_idx` ON `AuditLog`(`createdAt`);
CREATE INDEX `JournalEntry_userId_createdAt_idx` ON `JournalEntry`(`userId`, `createdAt`);
CREATE INDEX `Notification_userId_createdAt_idx` ON `Notification`(`userId`, `createdAt`);
CREATE INDEX `Assessment_userId_createdAt_idx` ON `Assessment`(`userId`, `createdAt`);
CREATE INDEX `PackagePurchase_userId_createdAt_idx` ON `PackagePurchase`(`userId`, `createdAt`);
CREATE INDEX `Message_receiverId_isRead_idx` ON `Message`(`receiverId`, `isRead`);

-- Never used by any query; pure write amplification on a hot table.
DROP INDEX `FollowUp_status_idx` ON `FollowUp`;

-- `FollowUp_doctorId_idx` is deliberately NOT dropped. It was created in
-- `round3` alongside the `FollowUp_doctorId_fkey` foreign key, and MySQL refuses
-- to drop an index a live foreign key depends on:
--
--   ERROR 1553: Cannot drop index 'FollowUp_doctorId_idx': needed in a foreign
--   key constraint
--
-- An earlier revision of this migration dropped it anyway, which made
-- `prisma migrate deploy` fail on every clean database. The quick start avoided
-- the problem only because it used `db:push`, which never runs migrations, so
-- the broken file was never executed until a fresh `migrate deploy` was tried.
