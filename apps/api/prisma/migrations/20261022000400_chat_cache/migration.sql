-- Кэш списка чатов: общая сводка по чату (одна строка на чат) и личные доступы сотрудников.
-- AlterTable
ALTER TABLE `OpenlineChat` ADD COLUMN `title` VARCHAR(255) NULL,
    ADD COLUMN `crm` JSON NULL,
    ADD COLUMN `phones` JSON NULL,
    ADD COLUMN `lastMessageId` INTEGER NULL,
    ADD COLUMN `lastPreview` VARCHAR(500) NULL,
    ADD COLUMN `lastHasFiles` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `summaryAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `OpenlineChatAccess` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `userId` INTEGER NOT NULL,
    `chatId` INTEGER NOT NULL,
    `allowed` BOOLEAN NOT NULL,
    `joined` BOOLEAN NOT NULL DEFAULT false,
    `checkedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OpenlineChatAccess_portalId_userId_chatId_key`(`portalId`, `userId`, `chatId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OpenlineChatAccess` ADD CONSTRAINT `OpenlineChatAccess_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
