-- Счета и ссылки на оплату (ADR 0009); разрешение менять поля существующих сделок (2026-10-22).
-- AlterTable
ALTER TABLE `PortalSettings` ADD COLUMN `updateDealFields` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `PaymentRequest` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(64) NOT NULL,
    `dealId` INTEGER NOT NULL,
    `bookingId` INTEGER NULL,
    `groupId` VARCHAR(191) NULL,
    `kind` ENUM('prepayment', 'surcharge') NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `invoiceId` INTEGER NULL,
    `link` VARCHAR(1000) NULL,
    `status` ENUM('link_pending', 'sent', 'paid', 'expired', 'failed', 'cancelled') NOT NULL DEFAULT 'link_pending',
    `deadlineAt` DATETIME(3) NULL,
    `messageSentAt` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `createdByUserId` INTEGER NOT NULL,
    `createdByName` VARCHAR(255) NULL,
    `error` VARCHAR(1000) NULL,
    `warnings` JSON NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PaymentRequest_portalId_dealId_idx`(`portalId`, `dealId`),
    INDEX `PaymentRequest_status_deadlineAt_idx`(`status`, `deadlineAt`),
    UNIQUE INDEX `PaymentRequest_portalId_idempotencyKey_key`(`portalId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PaymentRequest` ADD CONSTRAINT `PaymentRequest_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
