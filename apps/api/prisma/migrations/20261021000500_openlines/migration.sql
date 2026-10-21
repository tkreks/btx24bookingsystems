-- Открытые линии: личные шаблоны сообщений менеджеров и файлы вложений (до 10 МБ).
-- CreateTable
CREATE TABLE `MessageTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `ownerUserId` INTEGER NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `steps` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MessageTemplate_portalId_ownerUserId_idx`(`portalId`, `ownerUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StoredFile` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `ownerUserId` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `mime` VARCHAR(150) NOT NULL,
    `size` INTEGER NOT NULL,
    `data` LONGBLOB NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StoredFile_portalId_ownerUserId_idx`(`portalId`, `ownerUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MessageTemplate` ADD CONSTRAINT `MessageTemplate_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StoredFile` ADD CONSTRAINT `StoredFile_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
