-- CreateTable
CREATE TABLE `Messenger` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `auth` VARCHAR(8) NOT NULL DEFAULT 'code',
    `title` VARCHAR(255) NULL,
    `state` VARCHAR(20) NOT NULL DEFAULT 'starting',
    `account` VARCHAR(100) NULL,
    `lastError` VARCHAR(500) NULL,
    `connectedAt` DATETIME(3) NULL,
    `createdByUserId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Messenger_portalId_kind_phone_key`(`portalId`, `kind`, `phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Messenger` ADD CONSTRAINT `Messenger_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
