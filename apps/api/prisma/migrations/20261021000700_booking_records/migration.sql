-- Журнал броней приложения (ADR 0006): тип, статус, автор, причина отмены, история.
-- CreateTable
CREATE TABLE `BookingRecord` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `bookingId` INTEGER NOT NULL,
    `kind` ENUM('client', 'service') NOT NULL,
    `dealId` INTEGER NULL,
    `groupId` VARCHAR(191) NULL,
    `resourceIds` JSON NOT NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NOT NULL,
    `status` ENUM('active', 'cancelled') NOT NULL DEFAULT 'active',
    `cancelReason` ENUM('payment_timeout', 'manual') NULL,
    `createdByUserId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `cancelledAt` DATETIME(3) NULL,
    `cancelledByUserId` INTEGER NULL,

    INDEX `BookingRecord_portalId_createdByUserId_createdAt_idx`(`portalId`, `createdByUserId`, `createdAt`),
    INDEX `BookingRecord_portalId_createdByUserId_cancelledAt_idx`(`portalId`, `createdByUserId`, `cancelledAt`),
    UNIQUE INDEX `BookingRecord_portalId_bookingId_key`(`portalId`, `bookingId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BookingHistory` (
    `id` VARCHAR(191) NOT NULL,
    `recordId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(32) NOT NULL,
    `userId` INTEGER NULL,
    `details` JSON NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `BookingHistory_recordId_at_idx`(`recordId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BookingRecord` ADD CONSTRAINT `BookingRecord_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BookingHistory` ADD CONSTRAINT `BookingHistory_recordId_fkey` FOREIGN KEY (`recordId`) REFERENCES `BookingRecord`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- Клиентская бронь всегда со сделкой; интервал [start, end) непустой.
ALTER TABLE `BookingRecord` ADD CONSTRAINT `BookingRecord_client_has_deal`
  CHECK (`kind` <> 'client' OR `dealId` IS NOT NULL);
ALTER TABLE `BookingRecord` ADD CONSTRAINT `BookingRecord_interval`
  CHECK (`endsAt` > `startsAt`);
