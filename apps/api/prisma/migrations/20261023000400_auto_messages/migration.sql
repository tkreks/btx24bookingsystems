-- Назначение шаблона «Автоматическая рассылка» (системный шаблон для правил групп).
ALTER TABLE `MessageTemplate` MODIFY `purpose` ENUM('chat', 'payment', 'auto') NOT NULL DEFAULT 'chat';

-- Журнал автосообщений: одно сообщение на правило и бронь (повтор прохода worker'а не задвоит).
CREATE TABLE `AutoMessageLog` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `ruleId` VARCHAR(40) NOT NULL,
    `bookingId` INTEGER NOT NULL,
    `dealId` INTEGER NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `error` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,

    INDEX `AutoMessageLog_portalId_createdAt_idx`(`portalId`, `createdAt`),
    UNIQUE INDEX `AutoMessageLog_portalId_ruleId_bookingId_key`(`portalId`, `ruleId`, `bookingId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AutoMessageLog` ADD CONSTRAINT `AutoMessageLog_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
