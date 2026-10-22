-- Кто может открыть приложение (кроме администраторов портала и приложения) — решение владельца 2026-10-22.
-- CreateTable
CREATE TABLE `AppUser` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `kind` ENUM('USER', 'DEPARTMENT') NOT NULL,
    `bitrixId` INTEGER NOT NULL,

    UNIQUE INDEX `AppUser_portalId_kind_bitrixId_key`(`portalId`, `kind`, `bitrixId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AppUser` ADD CONSTRAINT `AppUser_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
