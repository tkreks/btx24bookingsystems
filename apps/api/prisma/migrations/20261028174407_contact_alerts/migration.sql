-- AlterTable
ALTER TABLE `PortalSettings` ADD COLUMN `contactSystemUserIds` JSON NULL;

-- CreateTable
CREATE TABLE `ContactAlert` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `contactId` INTEGER NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `changes` JSON NOT NULL,
    `actor` JSON NOT NULL,
    `fingerprint` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'new',
    `statusByUserId` INTEGER NULL,
    `statusAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `messageId` INTEGER NULL,
    `sendError` VARCHAR(500) NULL,

    INDEX `ContactAlert_portalId_status_createdAt_idx`(`portalId`, `status`, `createdAt`),
    INDEX `ContactAlert_portalId_contactId_createdAt_idx`(`portalId`, `contactId`, `createdAt`),
    UNIQUE INDEX `ContactAlert_portalId_fingerprint_key`(`portalId`, `fingerprint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ContactAlert` ADD CONSTRAINT `ContactAlert_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
