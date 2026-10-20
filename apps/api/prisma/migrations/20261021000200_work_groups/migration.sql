-- Группы (направления), их ресурсы и участники, администраторы приложения, настройки портала (ADR 0005).
-- CreateTable
CREATE TABLE `WorkGroup` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `dealCategoryId` INTEGER NULL,
    `bookingMode` ENUM('duration', 'interval') NOT NULL DEFAULT 'duration',
    `durationMinutes` INTEGER NOT NULL DEFAULT 60,
    `checkInTime` CHAR(5) NOT NULL DEFAULT '14:00',
    `checkOutTime` CHAR(5) NOT NULL DEFAULT '12:00',
    `defaultNights` INTEGER NOT NULL DEFAULT 1,
    `techWindowMinutes` INTEGER NOT NULL DEFAULT 0,
    `features` JSON NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WorkGroup_portalId_archivedAt_idx`(`portalId`, `archivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkGroupResource` (
    `groupId` VARCHAR(191) NOT NULL,
    `resourceId` INTEGER NOT NULL,

    PRIMARY KEY (`groupId`, `resourceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkGroupMember` (
    `id` VARCHAR(191) NOT NULL,
    `groupId` VARCHAR(191) NOT NULL,
    `kind` ENUM('USER', 'DEPARTMENT') NOT NULL,
    `bitrixId` INTEGER NOT NULL,
    `role` ENUM('VIEWER', 'TECHNOLOGIST', 'MANAGER', 'GROUP_ADMIN') NOT NULL,

    UNIQUE INDEX `WorkGroupMember_groupId_kind_bitrixId_key`(`groupId`, `kind`, `bitrixId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AppAdmin` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `kind` ENUM('USER', 'DEPARTMENT') NOT NULL,
    `bitrixId` INTEGER NOT NULL,

    UNIQUE INDEX `AppAdmin_portalId_kind_bitrixId_key`(`portalId`, `kind`, `bitrixId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PortalSettings` (
    `portalId` VARCHAR(191) NOT NULL,
    `dialogMetadataEnabled` BOOLEAN NOT NULL DEFAULT false,
    `dialogTextsEnabled` BOOLEAN NOT NULL DEFAULT false,
    `updatedByUserId` INTEGER NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`portalId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WorkGroup` ADD CONSTRAINT `WorkGroup_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkGroupResource` ADD CONSTRAINT `WorkGroupResource_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `WorkGroup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkGroupMember` ADD CONSTRAINT `WorkGroupMember_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `WorkGroup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AppAdmin` ADD CONSTRAINT `AppAdmin_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PortalSettings` ADD CONSTRAINT `PortalSettings_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Диапазоны настроек группы: защищают от мусора при прямой записи, а не только через API.
ALTER TABLE `WorkGroup` ADD CONSTRAINT `WorkGroup_ranges` CHECK (
  `durationMinutes` BETWEEN 1 AND 10080
  AND `defaultNights` BETWEEN 0 AND 365
  AND `techWindowMinutes` BETWEEN 0 AND 1440
  AND `checkInTime` REGEXP '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND `checkOutTime` REGEXP '^([01][0-9]|2[0-3]):[0-5][0-9]$'
);
