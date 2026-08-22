-- Referral session credits + 2FA backup codes
ALTER TABLE `User` ADD COLUMN `backupCodes` TEXT NULL,
    ADD COLUMN `sessionCredits` INTEGER NOT NULL DEFAULT 0;

-- Booking paid with a referral credit instead of the session fee
ALTER TABLE `Appointment` ADD COLUMN `creditApplied` BOOLEAN NOT NULL DEFAULT false;

-- Hot-path composite indexes (chat threads, notification badges, cron scans,
-- conflict checks, slot discovery)
CREATE INDEX `Appointment_doctorId_appointmentDate_status_idx` ON `Appointment`(`doctorId`, `appointmentDate`, `status`);
CREATE INDEX `Appointment_userId_status_idx` ON `Appointment`(`userId`, `status`);
CREATE INDEX `Message_senderId_receiverId_createdAt_idx` ON `Message`(`senderId`, `receiverId`, `createdAt`);
CREATE INDEX `Message_receiverId_senderId_idx` ON `Message`(`receiverId`, `senderId`);
CREATE INDEX `Notification_userId_isRead_createdAt_idx` ON `Notification`(`userId`, `isRead`, `createdAt`);
CREATE INDEX `ConsultationSlot_doctorId_date_isBooked_idx` ON `ConsultationSlot`(`doctorId`, `date`, `isBooked`);
CREATE INDEX `MoodEntry_userId_createdAt_idx` ON `MoodEntry`(`userId`, `createdAt`);
