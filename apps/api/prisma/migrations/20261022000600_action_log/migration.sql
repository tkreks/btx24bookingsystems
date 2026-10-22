-- Журнал действий в приложении (решение владельца 2026-10-22): вход, правки «было → стало», брони,
-- оплаты, настройки, действия системы. Только добавление.
-- CreateTable
CREATE TABLE `ActionLog` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actorKind` ENUM('user', 'system', 'bitrix') NOT NULL DEFAULT 'user',
    `userId` INTEGER NULL,
    `actorName` VARCHAR(255) NULL,
    `action` VARCHAR(64) NOT NULL,
    `entityType` VARCHAR(32) NULL,
    `entityId` VARCHAR(64) NULL,
    `summary` VARCHAR(500) NOT NULL,
    `details` JSON NULL,
    `via` VARCHAR(32) NULL,

    INDEX `ActionLog_portalId_at_idx`(`portalId`, `at`),
    INDEX `ActionLog_portalId_entityType_entityId_at_idx`(`portalId`, `entityType`, `entityId`, `at`),
    INDEX `ActionLog_portalId_userId_at_idx`(`portalId`, `userId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ActionLog` ADD CONSTRAINT `ActionLog_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Журнал нельзя исправить или стереть задним числом — только дописать.
CREATE TRIGGER `ActionLog_no_update` BEFORE UPDATE ON `ActionLog` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ActionLog is append-only';
CREATE TRIGGER `ActionLog_no_delete` BEFORE DELETE ON `ActionLog` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ActionLog is append-only';
