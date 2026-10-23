-- Аватарка клиента открытой линии (кэш сводки чата) и чаты, скрытые сотрудником с его дашборда.

-- AlterTable
ALTER TABLE `OpenlineChat` ADD COLUMN `clientAvatar` VARCHAR(1000) NULL;

-- CreateTable
CREATE TABLE `DashboardHiddenChat` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `userId` INTEGER NOT NULL,
    `chatId` INTEGER NOT NULL,
    `hiddenAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DashboardHiddenChat_portalId_userId_chatId_key`(`portalId`, `userId`, `chatId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DashboardHiddenChat` ADD CONSTRAINT `DashboardHiddenChat_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
