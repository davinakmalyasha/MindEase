-- DropIndex
DROP INDEX `User_weeklyReportEnabled_role_idx` ON `User`;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `lastWeeklyReportAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `User_weeklyReportEnabled_role_lastWeeklyReportAt_idx` ON `User`(`weeklyReportEnabled`, `role`, `lastWeeklyReportAt`);
