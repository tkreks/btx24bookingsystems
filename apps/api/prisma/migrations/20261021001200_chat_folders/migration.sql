-- Личные папки чатов сотрудника (внутренние чаты: охрана, ресепшн, АХО…).
-- CreateTable
CREATE TABLE `ChatFolder` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `ownerUserId` INTEGER NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ChatFolder_portalId_ownerUserId_idx`(`portalId`, `ownerUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChatFolderItem` (
    `id` VARCHAR(191) NOT NULL,
    `folderId` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `ownerUserId` INTEGER NOT NULL,
    `chatId` INTEGER NOT NULL,
    `addedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ChatFolderItem_folderId_idx`(`folderId`),
    UNIQUE INDEX `ChatFolderItem_portalId_ownerUserId_chatId_key`(`portalId`, `ownerUserId`, `chatId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ChatFolder` ADD CONSTRAINT `ChatFolder_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChatFolderItem` ADD CONSTRAINT `ChatFolderItem_folderId_fkey` FOREIGN KEY (`folderId`) REFERENCES `ChatFolder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

