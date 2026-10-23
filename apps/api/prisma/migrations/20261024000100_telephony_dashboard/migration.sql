-- CreateTable
CREATE TABLE `TelephonyCall` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `callId` VARCHAR(100) NOT NULL,
    `callType` INTEGER NULL,
    `phone` VARCHAR(40) NULL,
    `userId` INTEGER NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `answeredAt` DATETIME(3) NULL,
    `endedAt` DATETIME(3) NULL,
    `crmActivityId` INTEGER NULL,

    INDEX `TelephonyCall_portalId_userId_answeredAt_idx`(`portalId`, `userId`, `answeredAt`),
    UNIQUE INDEX `TelephonyCall_portalId_callId_key`(`portalId`, `callId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DashboardLayout` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `userId` INTEGER NOT NULL,
    `blocks` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DashboardLayout_portalId_userId_key`(`portalId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TelephonyCall` ADD CONSTRAINT `TelephonyCall_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DashboardLayout` ADD CONSTRAINT `DashboardLayout_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
