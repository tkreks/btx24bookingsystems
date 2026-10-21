-- Индекс диалогов открытых линий: метаданные для сортировки по последнему сообщению (без текстов).
-- CreateTable
CREATE TABLE `OpenlineChat` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `chatId` INTEGER NOT NULL,
    `sessionId` INTEGER NOT NULL,
    `responsibleId` INTEGER NULL,
    `completed` BOOLEAN NOT NULL,
    `connector` VARCHAR(64) NOT NULL,
    `lastMessageAt` DATETIME(3) NULL,
    `lastAuthor` VARCHAR(10) NULL,
    `checkedAt` DATETIME(3) NOT NULL,

    INDEX `OpenlineChat_portalId_lastMessageAt_idx`(`portalId`, `lastMessageAt`),
    INDEX `OpenlineChat_portalId_responsibleId_lastMessageAt_idx`(`portalId`, `responsibleId`, `lastMessageAt`),
    UNIQUE INDEX `OpenlineChat_portalId_chatId_key`(`portalId`, `chatId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OpenlineChat` ADD CONSTRAINT `OpenlineChat_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
