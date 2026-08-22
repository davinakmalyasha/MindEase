-- AlterTable: notification preferences (JSON)
ALTER TABLE `User` ADD COLUMN `notificationPrefs` TEXT NULL;

-- AlterTable: review moderation
ALTER TABLE `Review` ADD COLUMN `hidden` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: weekly availability patterns
CREATE TABLE `AvailabilityPattern` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `doctorId` INTEGER NOT NULL,
    `weekday` INTEGER NOT NULL,
    `startTime` VARCHAR(191) NOT NULL,
    `endTime` VARCHAR(191) NOT NULL,
    `activeFrom` DATETIME(3) NOT NULL,
    `activeUntil` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AvailabilityPattern_doctorId_idx`(`doctorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: review reports (doctor-flagged reviews)
CREATE TABLE `ReviewReport` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reviewId` INTEGER NOT NULL,
    `reporterId` INTEGER NOT NULL,
    `reason` TEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReviewReport_reviewId_idx`(`reviewId`),
    INDEX `ReviewReport_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys
ALTER TABLE `AvailabilityPattern` ADD CONSTRAINT `AvailabilityPattern_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `Doctor`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ReviewReport` ADD CONSTRAINT `ReviewReport_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `Review`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ReviewReport` ADD CONSTRAINT `ReviewReport_reporterId_fkey` FOREIGN KEY (`reporterId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
