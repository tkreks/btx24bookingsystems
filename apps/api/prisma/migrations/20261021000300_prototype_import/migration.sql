-- Импорт прототипа Node-RED: legacyId/options групп, внешние пользователи (только хеш пароля),
-- флаг очистки e-mail wazzup. Лишние MODIFY … JSON из migrate diff убраны (MariaDB: JSON = LONGTEXT).

-- AlterTable
ALTER TABLE `PortalSettings` ADD COLUMN `removeWazzupEmail` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `WorkGroup` ADD COLUMN `legacyId` VARCHAR(64) NULL,
    ADD COLUMN `options` JSON NULL;

-- CreateTable
CREATE TABLE `ExternalUser` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `login` VARCHAR(100) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `role` ENUM('VIEWER', 'TECHNOLOGIST') NOT NULL,
    `allGroups` BOOLEAN NOT NULL DEFAULT false,
    `visibleFields` JSON NULL,
    `disabledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ExternalUser_portalId_login_key`(`portalId`, `login`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExternalUserGroup` (
    `externalUserId` VARCHAR(191) NOT NULL,
    `groupId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`externalUserId`, `groupId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `WorkGroup_portalId_legacyId_key` ON `WorkGroup`(`portalId`, `legacyId`);

-- AddForeignKey
ALTER TABLE `ExternalUser` ADD CONSTRAINT `ExternalUser_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExternalUserGroup` ADD CONSTRAINT `ExternalUserGroup_externalUserId_fkey` FOREIGN KEY (`externalUserId`) REFERENCES `ExternalUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExternalUserGroup` ADD CONSTRAINT `ExternalUserGroup_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `WorkGroup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

