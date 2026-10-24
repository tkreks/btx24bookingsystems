-- AlterTable
ALTER TABLE `Messenger` ADD COLUMN `lineMode` VARCHAR(10) NULL,
    ADD COLUMN `lineId` INTEGER NULL,
    ADD COLUMN `lineName` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `MessengerChat` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `messengerId` VARCHAR(191) NOT NULL,
    `chatId` VARCHAR(100) NOT NULL,
    `phone` VARCHAR(20) NULL,
    `name` VARCHAR(255) NULL,
    `lastMessageAt` DATETIME(3) NULL,
    `lastText` VARCHAR(500) NULL,
    `unread` INTEGER NOT NULL DEFAULT 0,

    INDEX `MessengerChat_messengerId_lastMessageAt_idx`(`messengerId`, `lastMessageAt`),
    UNIQUE INDEX `MessengerChat_messengerId_chatId_key`(`messengerId`, `chatId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MessengerMessage` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `messengerId` VARCHAR(191) NOT NULL,
    `chatId` VARCHAR(100) NOT NULL,
    `externalId` VARCHAR(190) NOT NULL,
    `fromMe` BOOLEAN NOT NULL,
    `author` VARCHAR(100) NULL,
    `body` TEXT NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `hasMedia` BOOLEAN NOT NULL DEFAULT false,
    `quotedId` VARCHAR(190) NULL,
    `sentAt` DATETIME(3) NOT NULL,
    `ack` INTEGER NULL,
    `editedAt` DATETIME(3) NULL,
    `edits` JSON NULL,
    `deletedAt` DATETIME(3) NULL,
    `source` VARCHAR(10) NOT NULL DEFAULT 'messenger',
    `sentByUserId` INTEGER NULL,
    `b24MessageId` INTEGER NULL,
    `b24ChatId` INTEGER NULL,
    `relayedAt` DATETIME(3) NULL,
    `relayError` VARCHAR(500) NULL,

    INDEX `MessengerMessage_messengerId_chatId_sentAt_idx`(`messengerId`, `chatId`, `sentAt`),
    INDEX `MessengerMessage_messengerId_b24MessageId_idx`(`messengerId`, `b24MessageId`),
    UNIQUE INDEX `MessengerMessage_messengerId_externalId_key`(`messengerId`, `externalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MessengerChat` ADD CONSTRAINT `MessengerChat_messengerId_fkey` FOREIGN KEY (`messengerId`) REFERENCES `Messenger`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessengerMessage` ADD CONSTRAINT `MessengerMessage_messengerId_fkey` FOREIGN KEY (`messengerId`) REFERENCES `Messenger`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
