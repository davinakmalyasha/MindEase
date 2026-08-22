-- AlterTable: mood factors
ALTER TABLE `MoodEntry` ADD COLUMN `factors` TEXT NULL;

-- AlterTable: weekly wellness report opt-in
ALTER TABLE `User` ADD COLUMN `weeklyReportEnabled` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: doctor replies to reviews
ALTER TABLE `Review` ADD COLUMN `reply` TEXT NULL,
    ADD COLUMN `repliedAt` DATETIME(3) NULL;

-- AlterTable: message read receipts + attachments
ALTER TABLE `Message` ADD COLUMN `readAt` DATETIME(3) NULL,
    ADD COLUMN `attachmentUrl` VARCHAR(191) NULL,
    ADD COLUMN `attachmentType` VARCHAR(50) NULL;

-- CreateTable: journal entries
CREATE TABLE `JournalEntry` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `content` TEXT NOT NULL,
    `aiSummary` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `JournalEntry_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: standardized clinical assessments (PHQ-9 / GAD-7)
CREATE TABLE `Assessment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `answersJson` TEXT NOT NULL,
    `score` INTEGER NOT NULL,
    `severity` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Assessment_userId_type_idx`(`userId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys
ALTER TABLE `JournalEntry` ADD CONSTRAINT `JournalEntry_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `Assessment` ADD CONSTRAINT `Assessment_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
