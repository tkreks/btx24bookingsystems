-- Переписки (ADR 0017): линия, внешний чат и ключ переписки у чата ОЛ; хранимая история.
ALTER TABLE `OpenlineChat` ADD COLUMN `convKey` VARCHAR(191) NULL,
    ADD COLUMN `extChatId` VARCHAR(190) NULL,
    ADD COLUMN `lineId` INTEGER NULL,
    ADD COLUMN `msgComplete` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `msgFromId` INTEGER NULL,
    ADD COLUMN `msgToId` INTEGER NULL;

-- CreateTable
CREATE TABLE `ChatLineChannel` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `lineId` INTEGER NOT NULL,
    `lineName` VARCHAR(255) NOT NULL,
    `channel` VARCHAR(64) NOT NULL,
    `auto` BOOLEAN NOT NULL DEFAULT true,
    `syncedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ChatLineChannel_portalId_lineId_key`(`portalId`, `lineId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OpenlineMessage` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `chatId` INTEGER NOT NULL,
    `messageId` INTEGER NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `authorKind` VARCHAR(10) NOT NULL,
    `mid` VARCHAR(190) NULL,
    `dto` JSON NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL,

    INDEX `OpenlineMessage_portalId_chatId_messageId_idx`(`portalId`, `chatId`, `messageId`),
    UNIQUE INDEX `OpenlineMessage_portalId_messageId_key`(`portalId`, `messageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `OpenlineChat_portalId_convKey_idx` ON `OpenlineChat`(`portalId`, `convKey`);

-- AddForeignKey
ALTER TABLE `ChatLineChannel` ADD CONSTRAINT `ChatLineChannel_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OpenlineMessage` ADD CONSTRAINT `OpenlineMessage_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

