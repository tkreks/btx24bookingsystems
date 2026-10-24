-- Рабочий день в приложении: текущее состояние и история (синхронно с timeman Битрикс24).
-- CreateTable
CREATE TABLE `WorkdayState` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `userId` INTEGER NOT NULL,
    `status` VARCHAR(10) NOT NULL,
    `timeStart` DATETIME(3) NULL,
    `duration` VARCHAR(12) NULL,
    `timeLeaks` VARCHAR(12) NULL,
    `source` VARCHAR(10) NOT NULL,
    `changedAt` DATETIME(3) NOT NULL,
    `syncedAt` DATETIME(3) NULL,
    `pendingAction` VARCHAR(10) NULL,
    `pendingReport` VARCHAR(1000) NULL,
    `syncError` VARCHAR(500) NULL,

    UNIQUE INDEX `WorkdayState_portalId_userId_key`(`portalId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkdayEvent` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `userId` INTEGER NOT NULL,
    `action` VARCHAR(10) NOT NULL,
    `status` VARCHAR(10) NOT NULL,
    `source` VARCHAR(10) NOT NULL,
    `report` VARCHAR(1000) NULL,
    `at` DATETIME(3) NOT NULL,

    INDEX `WorkdayEvent_portalId_userId_at_idx`(`portalId`, `userId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WorkdayState` ADD CONSTRAINT `WorkdayState_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkdayEvent` ADD CONSTRAINT `WorkdayEvent_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Только статусы и действия учёта времени Битрикс24 — опечатка в коде не попадёт в базу.
ALTER TABLE `WorkdayState` ADD CONSTRAINT `WorkdayState_status_check` CHECK (`status` IN ('OPENED', 'PAUSED', 'CLOSED', 'EXPIRED'));
ALTER TABLE `WorkdayState` ADD CONSTRAINT `WorkdayState_source_check` CHECK (`source` IN ('app', 'bitrix'));
ALTER TABLE `WorkdayState` ADD CONSTRAINT `WorkdayState_pending_check` CHECK (`pendingAction` IS NULL OR `pendingAction` IN ('open', 'pause', 'close'));
ALTER TABLE `WorkdayEvent` ADD CONSTRAINT `WorkdayEvent_action_check` CHECK (`action` IN ('open', 'pause', 'resume', 'close'));
ALTER TABLE `WorkdayEvent` ADD CONSTRAINT `WorkdayEvent_source_check` CHECK (`source` IN ('app', 'bitrix'));
