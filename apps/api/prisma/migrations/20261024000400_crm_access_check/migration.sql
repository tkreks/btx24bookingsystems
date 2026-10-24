-- CreateTable
CREATE TABLE `CrmAccessCheck` (
    `portalId` VARCHAR(191) NOT NULL,
    `userId` INTEGER NOT NULL,
    `entityTypeId` INTEGER NOT NULL,
    `entityId` INTEGER NOT NULL,
    `allowed` BOOLEAN NOT NULL,
    `checkedAt` DATETIME(3) NOT NULL,

    INDEX `CrmAccessCheck_checkedAt_idx`(`checkedAt`),
    PRIMARY KEY (`portalId`, `userId`, `entityTypeId`, `entityId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CrmAccessCheck` ADD CONSTRAINT `CrmAccessCheck_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
