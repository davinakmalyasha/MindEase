-- UUIDv7 primary keys.
--
-- Every model's primary key and every id-typed column becomes a CHAR(36)
-- UUIDv7, so the internal sequential integer ids the product used to expose no
-- longer exist anywhere: there is nothing left to leak. Prisma generates the
-- values client-side (`@default(uuid(7))`), which is time-ordered, so `id`
-- ordering keeps its previous meaning.
--
-- **This migration is destructive.** Changing a key's type cannot preserve
-- rows, and the project has no production data to preserve: it drops and
-- recreates every table. Run the seed afterwards (`npm run db:seed`) - CI
-- starts from an empty database, so the drops are no-ops there.

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS `User`;
DROP TABLE IF EXISTS `Doctor`;
DROP TABLE IF EXISTS `Appointment`;
DROP TABLE IF EXISTS `Review`;
DROP TABLE IF EXISTS `ReviewReport`;
DROP TABLE IF EXISTS `Message`;
DROP TABLE IF EXISTS `Notification`;
DROP TABLE IF EXISTS `ConsultationSlot`;
DROP TABLE IF EXISTS `AvailabilityPattern`;
DROP TABLE IF EXISTS `PreSessionData`;
DROP TABLE IF EXISTS `RiskAlert`;
DROP TABLE IF EXISTS `RefreshToken`;
DROP TABLE IF EXISTS `MoodEntry`;
DROP TABLE IF EXISTS `JournalEntry`;
DROP TABLE IF EXISTS `Assessment`;
DROP TABLE IF EXISTS `CarePlan`;
DROP TABLE IF EXISTS `CareGoal`;
DROP TABLE IF EXISTS `CareStep`;
DROP TABLE IF EXISTS `SafetyPlan`;
DROP TABLE IF EXISTS `AuditLog`;
DROP TABLE IF EXISTS `JobLock`;
DROP TABLE IF EXISTS `FollowUp`;
DROP TABLE IF EXISTS `WaitlistEntry`;
DROP TABLE IF EXISTS `Package`;
DROP TABLE IF EXISTS `PackagePurchase`;
DROP TABLE IF EXISTS `PaymentOrder`;
DROP TABLE IF EXISTS `PushSubscription`;
DROP TABLE IF EXISTS `Referral`;
SET FOREIGN_KEY_CHECKS = 1;

-- CreateTable
CREATE TABLE `User` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `password` VARCHAR(191) NULL,
    `name` VARCHAR(191) NULL,
    `avatar` VARCHAR(191) NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT 'patient',
    `phone_number` VARCHAR(191) NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'local',
    `googleId` VARCHAR(191) NULL,
    `isBanned` BOOLEAN NOT NULL DEFAULT false,
    `isVerified` BOOLEAN NOT NULL DEFAULT false,
    `weeklyReportEnabled` BOOLEAN NOT NULL DEFAULT false,
    `notificationPrefs` TEXT NULL,
    `referralCode` VARCHAR(191) NULL,
    `timezone` VARCHAR(191) NULL DEFAULT 'Asia/Jakarta',
    `lastMoodNudgeAt` DATETIME(3) NULL,
    `lastDeclineNudgeAt` DATETIME(3) NULL,
    `lastWeeklyReportAt` DATETIME(3) NULL,
    `failedAttempts` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `totpSecret` VARCHAR(191) NULL,
    `totpEnabled` BOOLEAN NOT NULL DEFAULT false,
    `backupCodes` TEXT NULL,
    `lastTotpStep` INTEGER NULL,
    `sessionCredits` INTEGER NOT NULL DEFAULT 0,
    `resetOtpHash` VARCHAR(191) NULL,
    `resetOtpExpiresAt` DATETIME(3) NULL,
    `resetOtpAttempts` INTEGER NOT NULL DEFAULT 0,
    `verifyOtpHash` VARCHAR(191) NULL,
    `verifyOtpExpiresAt` DATETIME(3) NULL,
    `verifyOtpAttempts` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    UNIQUE INDEX `User_googleId_key`(`googleId`),
    UNIQUE INDEX `User_referralCode_key`(`referralCode`),
    INDEX `User_role_lastMoodNudgeAt_idx`(`role`, `lastMoodNudgeAt`),
    INDEX `User_role_lastDeclineNudgeAt_idx`(`role`, `lastDeclineNudgeAt`),
    INDEX `User_weeklyReportEnabled_role_lastWeeklyReportAt_idx`(`weeklyReportEnabled`, `role`, `lastWeeklyReportAt`),
    INDEX `User_createdAt_idx`(`createdAt`),
    INDEX `User_role_createdAt_idx`(`role`, `createdAt`),
    INDEX `User_role_id_idx`(`role`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Doctor` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `specialty` VARCHAR(191) NOT NULL,
    `bio` TEXT NOT NULL,
    `experience` INTEGER NOT NULL DEFAULT 0,
    `rating` DOUBLE NOT NULL DEFAULT 0,
    `totalReviews` INTEGER NOT NULL DEFAULT 0,
    `languages` VARCHAR(191) NULL,
    `education` TEXT NULL,
    `price` INTEGER NOT NULL DEFAULT 0,
    `bankName` VARCHAR(191) NULL,
    `bankAccount` VARCHAR(191) NULL,
    `bankHolder` VARCHAR(191) NULL,
    `availability` VARCHAR(191) NOT NULL DEFAULT 'Available',
    `verificationStatus` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `licenseNumber` VARCHAR(191) NULL,
    `licenseIssuer` VARCHAR(191) NULL,
    `awayUntil` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Doctor_userId_key`(`userId`),
    INDEX `Doctor_verificationStatus_rating_idx`(`verificationStatus`, `rating`),
    INDEX `Doctor_specialty_price_idx`(`specialty`, `price`),
    INDEX `Doctor_experience_idx`(`experience`),
    INDEX `Doctor_verificationStatus_awayUntil_idx`(`verificationStatus`, `awayUntil`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Appointment` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `doctorId` CHAR(36) NOT NULL,
    `slotId` CHAR(36) NULL,
    `appointmentDate` DATETIME(3) NOT NULL,
    `startTime` VARCHAR(191) NULL,
    `endTime` VARCHAR(191) NULL,
    `consultationType` VARCHAR(191) NOT NULL DEFAULT 'video',
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `notes` TEXT NULL,
    `meetingLink` VARCHAR(191) NULL,
    `roomSeed` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `reminderSentAt` DATETIME(3) NULL,
    `checkinSentAt` DATETIME(3) NULL,
    `packagePurchaseId` CHAR(36) NULL,
    `creditApplied` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Appointment_slotId_key`(`slotId`),
    UNIQUE INDEX `Appointment_idempotencyKey_key`(`idempotencyKey`),
    INDEX `Appointment_doctorId_appointmentDate_status_idx`(`doctorId`, `appointmentDate`, `status`),
    INDEX `Appointment_userId_status_idx`(`userId`, `status`),
    INDEX `Appointment_reminderSentAt_appointmentDate_status_idx`(`reminderSentAt`, `appointmentDate`, `status`),
    INDEX `Appointment_appointmentDate_startTime_idx`(`appointmentDate`, `startTime`),
    INDEX `Appointment_checkinSentAt_appointmentDate_status_idx`(`checkinSentAt`, `appointmentDate`, `status`),
    INDEX `Appointment_status_reminderSentAt_appointmentDate_idx`(`status`, `reminderSentAt`, `appointmentDate`),
    INDEX `Appointment_status_checkinSentAt_appointmentDate_idx`(`status`, `checkinSentAt`, `appointmentDate`),
    INDEX `Appointment_userId_appointmentDate_idx`(`userId`, `appointmentDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Review` (
    `id` CHAR(36) NOT NULL,
    `rating` INTEGER NOT NULL,
    `comment` TEXT NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `doctorId` CHAR(36) NOT NULL,
    `appointmentId` CHAR(36) NULL,
    `reply` TEXT NULL,
    `repliedAt` DATETIME(3) NULL,
    `hidden` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Review_appointmentId_key`(`appointmentId`),
    INDEX `Review_doctorId_hidden_createdAt_idx`(`doctorId`, `hidden`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReviewReport` (
    `id` CHAR(36) NOT NULL,
    `reviewId` CHAR(36) NOT NULL,
    `reporterId` CHAR(36) NOT NULL,
    `reason` TEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReviewReport_reviewId_idx`(`reviewId`),
    INDEX `ReviewReport_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Message` (
    `id` CHAR(36) NOT NULL,
    `content` TEXT NOT NULL,
    `senderId` CHAR(36) NOT NULL,
    `receiverId` CHAR(36) NOT NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT false,
    `readAt` DATETIME(3) NULL,
    `attachmentUrl` VARCHAR(191) NULL,
    `attachmentType` VARCHAR(50) NULL,
    `deletedAt` DATETIME(3) NULL,
    `reaction` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Message_senderId_receiverId_createdAt_idx`(`senderId`, `receiverId`, `createdAt`),
    INDEX `Message_senderId_receiverId_id_idx`(`senderId`, `receiverId`, `id`),
    INDEX `Message_receiverId_senderId_id_idx`(`receiverId`, `senderId`, `id`),
    INDEX `Message_senderId_createdAt_idx`(`senderId`, `createdAt`),
    INDEX `Message_receiverId_senderId_idx`(`receiverId`, `senderId`),
    INDEX `Message_receiverId_isRead_idx`(`receiverId`, `isRead`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `message` TEXT NOT NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT false,
    `type` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Notification_userId_isRead_createdAt_idx`(`userId`, `isRead`, `createdAt`),
    INDEX `Notification_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `Notification_userId_createdAt_id_idx`(`userId`, `createdAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ConsultationSlot` (
    `id` CHAR(36) NOT NULL,
    `doctorId` CHAR(36) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `startTime` VARCHAR(191) NOT NULL,
    `endTime` VARCHAR(191) NOT NULL,
    `isBooked` BOOLEAN NOT NULL DEFAULT false,

    INDEX `ConsultationSlot_doctorId_date_isBooked_idx`(`doctorId`, `date`, `isBooked`),
    UNIQUE INDEX `ConsultationSlot_doctorId_date_startTime_endTime_key`(`doctorId`, `date`, `startTime`, `endTime`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AvailabilityPattern` (
    `id` CHAR(36) NOT NULL,
    `doctorId` CHAR(36) NOT NULL,
    `weekday` INTEGER NOT NULL,
    `startTime` VARCHAR(191) NOT NULL,
    `endTime` VARCHAR(191) NOT NULL,
    `activeFrom` DATETIME(3) NOT NULL,
    `activeUntil` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AvailabilityPattern_doctorId_idx`(`doctorId`),
    UNIQUE INDEX `AvailabilityPattern_doctorId_weekday_startTime_endTime_key`(`doctorId`, `weekday`, `startTime`, `endTime`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PreSessionData` (
    `id` CHAR(36) NOT NULL,
    `appointmentId` CHAR(36) NOT NULL,
    `questionsJson` TEXT NULL,
    `answersJson` TEXT NULL,
    `briefingText` TEXT NULL,
    `briefingSource` VARCHAR(191) NOT NULL DEFAULT 'model',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PreSessionData_appointmentId_key`(`appointmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RiskAlert` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `level` VARCHAR(191) NOT NULL,
    `reason` TEXT NOT NULL,
    `sourceType` VARCHAR(191) NOT NULL,
    `sourceId` CHAR(36) NULL,
    `acknowledgedAt` DATETIME(3) NULL,
    `acknowledgedById` CHAR(36) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `resolvedById` CHAR(36) NULL,
    `resolutionNote` TEXT NULL,
    `notifiedDoctorUserId` CHAR(36) NULL,
    `assignedDoctorUserId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RiskAlert_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `RiskAlert_acknowledgedAt_idx`(`acknowledgedAt`),
    INDEX `RiskAlert_createdAt_idx`(`createdAt`),
    INDEX `RiskAlert_assignedDoctorUserId_resolvedAt_createdAt_idx`(`assignedDoctorUserId`, `resolvedAt`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefreshToken` (
    `id` CHAR(36) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RefreshToken_tokenHash_key`(`tokenHash`),
    INDEX `RefreshToken_userId_idx`(`userId`),
    INDEX `RefreshToken_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MoodEntry` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `mood` INTEGER NOT NULL,
    `notes` TEXT NULL,
    `moodDate` VARCHAR(10) NOT NULL,
    `factors` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `MoodEntry_userId_createdAt_idx`(`userId`, `createdAt`),
    UNIQUE INDEX `MoodEntry_userId_moodDate_key`(`userId`, `moodDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JournalEntry` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `content` TEXT NOT NULL,
    `aiSummary` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `JournalEntry_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Assessment` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `answersJson` TEXT NOT NULL,
    `score` INTEGER NOT NULL,
    `severity` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Assessment_userId_type_idx`(`userId`, `type`),
    INDEX `Assessment_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CarePlan` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `doctorUserId` CHAR(36) NULL,
    `title` VARCHAR(160) NOT NULL DEFAULT 'My care plan',
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `summary` TEXT NULL,
    `reviewAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,

    INDEX `CarePlan_userId_status_idx`(`userId`, `status`),
    INDEX `CarePlan_doctorUserId_idx`(`doctorUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CareGoal` (
    `id` CHAR(36) NOT NULL,
    `carePlanId` CHAR(36) NOT NULL,
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

-- CreateTable
CREATE TABLE `CareStep` (
    `id` CHAR(36) NOT NULL,
    `careGoalId` CHAR(36) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `done` BOOLEAN NOT NULL DEFAULT false,
    `doneAt` DATETIME(3) NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CareStep_careGoalId_order_idx`(`careGoalId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SafetyPlan` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `warningSigns` TEXT NULL,
    `copingStrategies` TEXT NULL,
    `reasonsToLive` TEXT NULL,
    `contacts` TEXT NULL,
    `professionalContact` VARCHAR(255) NULL,
    `locationToBeSafe` VARCHAR(255) NULL,
    `lastReviewedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `SafetyPlan_userId_key`(`userId`),
    INDEX `SafetyPlan_lastReviewedAt_idx`(`lastReviewedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` CHAR(36) NOT NULL,
    `actorId` CHAR(36) NULL,
    `action` VARCHAR(191) NOT NULL,
    `targetType` VARCHAR(191) NULL,
    `targetId` CHAR(36) NULL,
    `meta` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_actorId_idx`(`actorId`),
    INDEX `AuditLog_targetType_targetId_idx`(`targetType`, `targetId`),
    INDEX `AuditLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobLock` (
    `key` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `JobLock_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FollowUp` (
    `id` CHAR(36) NOT NULL,
    `appointmentId` CHAR(36) NOT NULL,
    `doctorId` CHAR(36) NOT NULL,
    `suggestedDate` DATETIME(3) NOT NULL,
    `startTime` VARCHAR(191) NOT NULL,
    `endTime` VARCHAR(191) NOT NULL,
    `consultationType` VARCHAR(191) NOT NULL DEFAULT 'video',
    `notes` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `FollowUp_appointmentId_key`(`appointmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WaitlistEntry` (
    `id` CHAR(36) NOT NULL,
    `doctorId` CHAR(36) NOT NULL,
    `patientId` CHAR(36) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'waiting',
    `notifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WaitlistEntry_doctorId_status_idx`(`doctorId`, `status`),
    UNIQUE INDEX `WaitlistEntry_doctorId_patientId_key`(`doctorId`, `patientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Package` (
    `id` CHAR(36) NOT NULL,
    `doctorId` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `sessionCount` INTEGER NOT NULL,
    `totalPrice` INTEGER NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Package_doctorId_idx`(`doctorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PackagePurchase` (
    `id` CHAR(36) NOT NULL,
    `packageId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `sessionsLeft` INTEGER NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `paidAt` DATETIME(3) NULL,
    `grantedByUserId` CHAR(36) NULL,
    `totalPrice` INTEGER NOT NULL DEFAULT 0,
    `sessionCount` INTEGER NOT NULL DEFAULT 0,
    `reference` VARCHAR(191) NULL,
    `liveKey` VARCHAR(80) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PackagePurchase_liveKey_key`(`liveKey`),
    INDEX `PackagePurchase_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `PackagePurchase_userId_status_idx`(`userId`, `status`),
    INDEX `PackagePurchase_reference_idx`(`reference`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaymentOrder` (
    `id` CHAR(36) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `purchaseId` CHAR(36) NOT NULL,
    `amount` INTEGER NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'IDR',
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `reference` VARCHAR(128) NULL,
    `simulated` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `settledAt` DATETIME(3) NULL,

    UNIQUE INDEX `PaymentOrder_orderId_key`(`orderId`),
    UNIQUE INDEX `PaymentOrder_purchaseId_key`(`purchaseId`),
    INDEX `PaymentOrder_status_idx`(`status`),
    INDEX `PaymentOrder_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PushSubscription` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `endpoint` VARCHAR(500) NOT NULL,
    `p256dh` VARCHAR(500) NOT NULL,
    `auth` VARCHAR(500) NOT NULL,
    `userAgent` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PushSubscription_userId_idx`(`userId`),
    UNIQUE INDEX `PushSubscription_userId_endpoint_key`(`userId`, `endpoint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Referral` (
    `id` CHAR(36) NOT NULL,
    `referrerId` CHAR(36) NOT NULL,
    `referredId` CHAR(36) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Referral_referredId_key`(`referredId`),
    INDEX `Referral_referrerId_idx`(`referrerId`),
    INDEX `Referral_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Doctor` ADD CONSTRAINT `Doctor_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Appointment` ADD CONSTRAINT `Appointment_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Appointment` ADD CONSTRAINT `Appointment_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `Doctor`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Appointment` ADD CONSTRAINT `Appointment_slotId_fkey` FOREIGN KEY (`slotId`) REFERENCES `ConsultationSlot`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Appointment` ADD CONSTRAINT `Appointment_packagePurchaseId_fkey` FOREIGN KEY (`packagePurchaseId`) REFERENCES `PackagePurchase`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Review` ADD CONSTRAINT `Review_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Review` ADD CONSTRAINT `Review_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `Doctor`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Review` ADD CONSTRAINT `Review_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReviewReport` ADD CONSTRAINT `ReviewReport_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `Review`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReviewReport` ADD CONSTRAINT `ReviewReport_reporterId_fkey` FOREIGN KEY (`reporterId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_receiverId_fkey` FOREIGN KEY (`receiverId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ConsultationSlot` ADD CONSTRAINT `ConsultationSlot_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `Doctor`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AvailabilityPattern` ADD CONSTRAINT `AvailabilityPattern_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `Doctor`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PreSessionData` ADD CONSTRAINT `PreSessionData_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RiskAlert` ADD CONSTRAINT `RiskAlert_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefreshToken` ADD CONSTRAINT `RefreshToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MoodEntry` ADD CONSTRAINT `MoodEntry_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JournalEntry` ADD CONSTRAINT `JournalEntry_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Assessment` ADD CONSTRAINT `Assessment_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CarePlan` ADD CONSTRAINT `CarePlan_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CareGoal` ADD CONSTRAINT `CareGoal_carePlanId_fkey` FOREIGN KEY (`carePlanId`) REFERENCES `CarePlan`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CareStep` ADD CONSTRAINT `CareStep_careGoalId_fkey` FOREIGN KEY (`careGoalId`) REFERENCES `CareGoal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SafetyPlan` ADD CONSTRAINT `SafetyPlan_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FollowUp` ADD CONSTRAINT `FollowUp_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FollowUp` ADD CONSTRAINT `FollowUp_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `Doctor`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WaitlistEntry` ADD CONSTRAINT `WaitlistEntry_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `Doctor`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WaitlistEntry` ADD CONSTRAINT `WaitlistEntry_patientId_fkey` FOREIGN KEY (`patientId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Package` ADD CONSTRAINT `Package_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `Doctor`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PackagePurchase` ADD CONSTRAINT `PackagePurchase_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `Package`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PackagePurchase` ADD CONSTRAINT `PackagePurchase_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentOrder` ADD CONSTRAINT `PaymentOrder_purchaseId_fkey` FOREIGN KEY (`purchaseId`) REFERENCES `PackagePurchase`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PushSubscription` ADD CONSTRAINT `PushSubscription_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Referral` ADD CONSTRAINT `Referral_referrerId_fkey` FOREIGN KEY (`referrerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Referral` ADD CONSTRAINT `Referral_referredId_fkey` FOREIGN KEY (`referredId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
