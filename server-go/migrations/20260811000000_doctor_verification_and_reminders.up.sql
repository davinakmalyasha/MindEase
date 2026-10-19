-- AlterTable
ALTER TABLE `Doctor` ADD COLUMN `verificationStatus` VARCHAR(191) NOT NULL DEFAULT 'pending',
    ADD COLUMN `licenseNumber` VARCHAR(191) NULL,
    ADD COLUMN `licenseIssuer` VARCHAR(191) NULL;

-- Backfill: doctors registered before this migration are considered approved
UPDATE `Doctor` SET `verificationStatus` = 'approved' WHERE `verificationStatus` = 'pending';

-- AlterTable
ALTER TABLE `Appointment` ADD COLUMN `reminderSentAt` DATETIME(3) NULL;
