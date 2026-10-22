-- Разрешение владельца (2026-10-22) создавать новые брони и сделки в Битрикс24 при B24_READ_ONLY.
-- AlterTable
ALTER TABLE `PortalSettings` ADD COLUMN `createInBitrix` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `createGrantedByUserId` INTEGER NULL,
    ADD COLUMN `createGrantedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `AppCreatedEntity` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(20) NOT NULL,
    `entityId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AppCreatedEntity_portalId_entityType_entityId_key`(`portalId`, `entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AppCreatedEntity` ADD CONSTRAINT `AppCreatedEntity_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Новое право группы «Создавать сделки» (deal.create): включаем там, где включено создание броней,
-- чтобы права менеджеров не сузились.
UPDATE `WorkGroup` SET `features` = JSON_ARRAY_APPEND(`features`, '$', 'deal.create')
WHERE JSON_CONTAINS(`features`, '"booking.create"') AND NOT JSON_CONTAINS(`features`, '"deal.create"');
