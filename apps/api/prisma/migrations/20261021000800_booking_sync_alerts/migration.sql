-- Синхронизация с Битрикс24 и аудит броней (ADR 0007): зеркало ресурсов, источник брони,
-- журнал действий с исполнителем и «было/стало», уведомления со статусами, чат уведомлений.

ALTER TABLE `BookingHistory` ADD COLUMN `actorKind` ENUM('user', 'system', 'bitrix') NOT NULL DEFAULT 'user',
    ADD COLUMN `actorName` VARCHAR(255) NULL,
    ADD COLUMN `after` JSON NULL,
    ADD COLUMN `before` JSON NULL,
    ADD COLUMN `via` VARCHAR(16) NOT NULL DEFAULT 'app';

ALTER TABLE `BookingRecord` ADD COLUMN `source` ENUM('app', 'bitrix') NOT NULL DEFAULT 'app',
    ADD COLUMN `syncedAt` DATETIME(3) NULL,
    ADD COLUMN `title` VARCHAR(255) NULL,
    MODIFY `cancelReason` ENUM('payment_timeout', 'manual', 'removed_in_bitrix') NULL,
    MODIFY `createdByUserId` INTEGER NULL;

ALTER TABLE `PortalSettings` ADD COLUMN `alertChatId` INTEGER NULL,
    ADD COLUMN `bookingSyncBaselineAt` DATETIME(3) NULL,
    ADD COLUMN `bookingSyncAt` DATETIME(3) NULL,
    ADD COLUMN `bookingSyncError` VARCHAR(500) NULL,
    ADD COLUMN `syncHorizonDays` INTEGER NOT NULL DEFAULT 180;

CREATE TABLE `Resource` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `resourceId` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `syncedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Resource_portalId_resourceId_key`(`portalId`, `resourceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `BookingAlert` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `kind` ENUM('new_booking', 'discrepancy') NOT NULL,
    `problem` VARCHAR(64) NULL,
    `bookingId` INTEGER NOT NULL,
    `dealId` INTEGER NULL,
    `expected` JSON NULL,
    `actual` JSON NULL,
    `fingerprint` VARCHAR(191) NOT NULL,
    `status` ENUM('new', 'viewed', 'resolved', 'ignored') NOT NULL DEFAULT 'new',
    `statusByUserId` INTEGER NULL,
    `statusByName` VARCHAR(255) NULL,
    `statusAt` DATETIME(3) NULL,
    `chatId` INTEGER NULL,
    `messageId` INTEGER NULL,
    `sendError` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `BookingAlert_portalId_status_createdAt_idx`(`portalId`, `status`, `createdAt`),
    UNIQUE INDEX `BookingAlert_portalId_fingerprint_key`(`portalId`, `fingerprint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Resource` ADD CONSTRAINT `Resource_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `BookingAlert` ADD CONSTRAINT `BookingAlert_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Бронь, найденная в Битрикс24 (онлайн-запись), может быть без сделки: правило «клиентская —
-- только со сделкой» остаётся для броней приложения.
ALTER TABLE `BookingRecord` DROP CONSTRAINT `BookingRecord_client_has_deal`;
ALTER TABLE `BookingRecord` ADD CONSTRAINT `BookingRecord_client_has_deal`
  CHECK (`source` <> 'app' OR `kind` <> 'client' OR `dealId` IS NOT NULL);
ALTER TABLE `BookingRecord` ADD CONSTRAINT `BookingRecord_app_has_author`
  CHECK (`source` <> 'app' OR `createdByUserId` IS NOT NULL);

-- Аудит только добавляется: правка и удаление строк истории запрещены (каскадное удаление
-- вместе с порталом триггеры не вызывает).
CREATE TRIGGER `BookingHistory_no_update` BEFORE UPDATE ON `BookingHistory` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BookingHistory is append-only';
CREATE TRIGGER `BookingHistory_no_delete` BEFORE DELETE ON `BookingHistory` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BookingHistory is append-only';
