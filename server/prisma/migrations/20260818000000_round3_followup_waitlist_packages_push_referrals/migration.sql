-- AlterTable: referral codes + timezone
ALTER TABLE `User` ADD COLUMN `referralCode` VARCHAR(191) NULL,
    ADD COLUMN `timezone` VARCHAR(191) NULL DEFAULT 'Asia/Jakarta',
    ADD COLUMN `lastMoodNudgeAt` DATETIME(3) NULL,
    ADD COLUMN `lastDeclineNudgeAt` DATETIME(3) NULL;

ALTER TABLE `User` ADD UNIQUE INDEX `User_referralCode_key`(`referralCode`);

-- AlterTable: doctor away mode
ALTER TABLE `Doctor` ADD COLUMN `awayUntil` DATETIME(3) NULL;

-- AlterTable: package-linked appointments + care check-ins
ALTER TABLE `Appointment` ADD COLUMN `packagePurchaseId` INTEGER NULL,
    ADD COLUMN `checkinSentAt` DATETIME(3) NULL;

-- AlterTable: chat upgrades
ALTER TABLE `Message` ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `reaction` VARCHAR(191) NULL;

-- CreateTable: follow-up scheduling
CREATE TABLE `FollowUp` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `appointmentId` INTEGER NOT NULL,
    `doctorId` INTEGER NOT NULL,
    `suggestedDate` DATETIME(3) NOT NULL,
    `startTime` VARCHAR(191) NOT NULL,
    `endTime` VARCHAR(191) NOT NULL,
    `consultationType` VARCHAR(191) NOT NULL DEFAULT 'video',
    `notes` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `FollowUp_appointmentId_key`(`appointmentId`),
    INDEX `FollowUp_doctorId_idx`(`doctorId`),
    INDEX `FollowUp_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: waitlists
CREATE TABLE `WaitlistEntry` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `doctorId` INTEGER NOT NULL,
    `patientId` INTEGER NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'waiting',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `WaitlistEntry_doctorId_patientId_status_key`(`doctorId`, `patientId`, `status`),
    INDEX `WaitlistEntry_doctorId_status_idx`(`doctorId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: therapy packages
CREATE TABLE `Package` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `doctorId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `sessionCount` INTEGER NOT NULL,
    `totalPrice` INTEGER NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Package_doctorId_idx`(`doctorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: package purchases
CREATE TABLE `PackagePurchase` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `packageId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `sessionsLeft` INTEGER NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PackagePurchase_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: web push subscriptions
CREATE TABLE `PushSubscription` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `endpoint` VARCHAR(500) NOT NULL,
    `p256dh` VARCHAR(500) NOT NULL,
    `auth` VARCHAR(500) NOT NULL,
    `userAgent` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PushSubscription_endpoint_key`(`endpoint`),
    INDEX `PushSubscription_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: referrals
CREATE TABLE `Referral` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `referrerId` INTEGER NOT NULL,
    `referredId` INTEGER NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Referral_referredId_key`(`referredId`),
    INDEX `Referral_referrerId_idx`(`referrerId`),
    INDEX `Referral_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys
ALTER TABLE `Appointment` ADD CONSTRAINT `Appointment_packagePurchaseId_fkey` FOREIGN KEY (`packagePurchaseId`) REFERENCES `PackagePurchase`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `FollowUp` ADD CONSTRAINT `FollowUp_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `FollowUp` ADD CONSTRAINT `FollowUp_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `Doctor`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `WaitlistEntry` ADD CONSTRAINT `WaitlistEntry_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `Doctor`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `WaitlistEntry` ADD CONSTRAINT `WaitlistEntry_patientId_fkey` FOREIGN KEY (`patientId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `Package` ADD CONSTRAINT `Package_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `Doctor`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PackagePurchase` ADD CONSTRAINT `PackagePurchase_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `Package`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PackagePurchase` ADD CONSTRAINT `PackagePurchase_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PushSubscription` ADD CONSTRAINT `PushSubscription_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `Referral` ADD CONSTRAINT `Referral_referrerId_fkey` FOREIGN KEY (`referrerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `Referral` ADD CONSTRAINT `Referral_referredId_fkey` FOREIGN KEY (`referredId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
