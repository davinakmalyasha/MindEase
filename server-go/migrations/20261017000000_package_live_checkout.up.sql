-- AlterTable
ALTER TABLE `PackagePurchase` ADD COLUMN `liveKey` VARCHAR(80) NULL;

-- Backfill the claim for the newest live checkout per (user, package).
-- Older duplicates from the pre-fix race stay pending but hold no key, so they
-- cannot block a legitimate checkout; settlement and expiry still act on them
-- by id.
UPDATE `PackagePurchase` p
JOIN (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY userId, packageId ORDER BY id DESC) AS rn
    FROM `PackagePurchase`
    WHERE status = 'pending' AND paidAt IS NULL
) ranked ON ranked.id = p.id
SET p.liveKey = CONCAT(p.userId, ':', p.packageId)
WHERE ranked.rn = 1;

-- CreateIndex
CREATE UNIQUE INDEX `PackagePurchase_liveKey_key` ON `PackagePurchase`(`liveKey`);
