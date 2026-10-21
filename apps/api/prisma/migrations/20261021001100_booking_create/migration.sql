-- Создание брони приложением (ADR 0007, 0008): системные поля сделки портала, сценарий оплаты
-- брони и журнал операции создания (идемпотентность, шаги, компенсация).
ALTER TABLE `PortalSettings` ADD COLUMN `dealFieldMap` JSON NULL;

ALTER TABLE `BookingRecord` ADD COLUMN `paymentMode` ENUM('prepayment', 'cash_on_site', 'postpay', 'free', 'certificate') NULL;

-- CreateTable
CREATE TABLE `BookingOperation` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(64) NOT NULL,
    `userId` INTEGER NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `steps` JSON NOT NULL,
    `bookingId` INTEGER NULL,
    `dealId` INTEGER NULL,
    `error` VARCHAR(1000) NULL,
    `request` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `BookingOperation_portalId_createdAt_idx`(`portalId`, `createdAt`),
    UNIQUE INDEX `BookingOperation_portalId_idempotencyKey_key`(`portalId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BookingOperation` ADD CONSTRAINT `BookingOperation_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

