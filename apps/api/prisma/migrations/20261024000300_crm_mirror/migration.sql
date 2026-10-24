-- CreateTable
CREATE TABLE `CrmDeal` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `dealId` INTEGER NOT NULL,
    `categoryId` INTEGER NULL,
    `contactId` INTEGER NULL,
    `assignedById` INTEGER NULL,
    `stageSemantic` VARCHAR(1) NULL,
    `createdAt` DATETIME(3) NULL,
    `modifiedAt` DATETIME(3) NULL,
    `row` JSON NOT NULL,
    `deletedAt` DATETIME(3) NULL,
    `syncedAt` DATETIME(3) NOT NULL,

    INDEX `CrmDeal_portalId_createdAt_idx`(`portalId`, `createdAt`),
    INDEX `CrmDeal_portalId_contactId_idx`(`portalId`, `contactId`),
    UNIQUE INDEX `CrmDeal_portalId_dealId_key`(`portalId`, `dealId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CrmEntity` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `entityTypeId` INTEGER NOT NULL,
    `entityId` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `photo` VARCHAR(1000) NULL,
    `row` JSON NOT NULL,
    `deletedAt` DATETIME(3) NULL,
    `syncedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CrmEntity_portalId_entityTypeId_entityId_key`(`portalId`, `entityTypeId`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CrmCall` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `activityId` INTEGER NOT NULL,
    `ownerTypeId` INTEGER NOT NULL,
    `ownerId` INTEGER NOT NULL,
    `responsibleId` INTEGER NULL,
    `startAt` DATETIME(3) NOT NULL,
    `row` JSON NOT NULL,
    `portalNumber` VARCHAR(40) NULL,
    `portalUserId` INTEGER NULL,
    `statsAt` DATETIME(3) NULL,
    `deletedAt` DATETIME(3) NULL,
    `syncedAt` DATETIME(3) NOT NULL,

    INDEX `CrmCall_portalId_startAt_idx`(`portalId`, `startAt`),
    UNIQUE INDEX `CrmCall_portalId_activityId_key`(`portalId`, `activityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PortalEmployee` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `userId` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `photo` VARCHAR(1000) NULL,
    `active` BOOLEAN NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PortalEmployee_portalId_userId_key`(`portalId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CrmSyncState` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `since` DATETIME(3) NULL,
    `backfillCursor` INTEGER NOT NULL DEFAULT 0,
    `backfillDoneAt` DATETIME(3) NULL,
    `fieldsKey` VARCHAR(2000) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CrmSyncState_portalId_kind_key`(`portalId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CrmDeal` ADD CONSTRAINT `CrmDeal_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CrmEntity` ADD CONSTRAINT `CrmEntity_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CrmCall` ADD CONSTRAINT `CrmCall_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PortalEmployee` ADD CONSTRAINT `PortalEmployee_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CrmSyncState` ADD CONSTRAINT `CrmSyncState_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
