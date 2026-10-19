-- Therapy-package checkout.
--
-- `paidAt` is the single signal that an entitlement is legitimate, and
-- `DoctorService.purchasePackage` refuses any grant that has neither a verified
-- `paidAt` nor an explicit administrator. These columns make that signal
-- auditable rather than inferred.
--
-- `totalPrice` and `sessionCount` are snapshots, not joins. A clinician can
-- re-price a package at any time, and a later edit must not silently change
-- what an existing customer paid or how many sessions they are owed.
ALTER TABLE `PackagePurchase`
    ADD COLUMN `totalPrice` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `sessionCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `reference` VARCHAR(191) NULL;

-- Serves the fallback callback lookup for any order created before
-- `PaymentOrder` existed.
CREATE INDEX `PackagePurchase_reference_idx` ON `PackagePurchase`(`reference`);

-- Backfill the snapshot from the package as it stands, so existing granted
-- purchases are not recorded as zero-value.
UPDATE `PackagePurchase` pp
JOIN `Package` p ON p.`id` = pp.`packageId`
SET pp.`totalPrice` = p.`totalPrice`,
    pp.`sessionCount` = p.`sessionCount`;

-- A checkout in flight. The provider is told an `orderId` before the patient is
-- redirected, and the same id comes back on the callback; holding the mapping
-- explicitly makes that callback a single indexed lookup and leaves room to
-- record status transitions for later reconciliation.
CREATE TABLE `PaymentOrder` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` VARCHAR(64) NOT NULL,
    `purchaseId` INTEGER NOT NULL,
    `amount` INTEGER NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'IDR',
    -- pending, paid, failed, expired
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `reference` VARCHAR(128) NULL,
    `simulated` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `settledAt` DATETIME(3) NULL,

    INDEX `PaymentOrder_status_idx`(`status`),
    INDEX `PaymentOrder_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `PaymentOrder_orderId_key`(`orderId`),
    UNIQUE INDEX `PaymentOrder_purchaseId_key`(`purchaseId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PaymentOrder`
    ADD CONSTRAINT `PaymentOrder_purchaseId_fkey`
    FOREIGN KEY (`purchaseId`) REFERENCES `PackagePurchase` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
