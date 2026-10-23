-- AlterTable
ALTER TABLE `Certificate` ADD COLUMN `kind` ENUM('paper', 'electronic') NULL,
    ADD COLUMN `saleKey` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `ChatFolder` ADD COLUMN `global` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `ChatFavorite` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `userId` INTEGER NOT NULL,
    `chatId` INTEGER NOT NULL,
    `addedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ChatFavorite_portalId_userId_chatId_key`(`portalId`, `userId`, `chatId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ResourceStop` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `resourceId` INTEGER NOT NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `createdByUserId` INTEGER NOT NULL,
    `createdByName` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `liftedAt` DATETIME(3) NULL,
    `liftedByName` VARCHAR(255) NULL,

    INDEX `ResourceStop_portalId_resourceId_startsAt_idx`(`portalId`, `resourceId`, `startsAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `Certificate_portalId_saleKey_key` ON `Certificate`(`portalId`, `saleKey`);

-- CreateIndex
CREATE INDEX `ChatFolder_portalId_global_idx` ON `ChatFolder`(`portalId`, `global`);

-- AddForeignKey
ALTER TABLE `ChatFavorite` ADD CONSTRAINT `ChatFavorite_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResourceStop` ADD CONSTRAINT `ResourceStop_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Стоп ресурса: конец позже начала.
ALTER TABLE `ResourceStop` ADD CONSTRAINT `ResourceStop_period` CHECK (`endsAt` > `startsAt`);
