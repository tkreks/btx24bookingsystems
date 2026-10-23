-- Руководители приложения (дашборд руководителя): сотрудники и отделы портала.

-- CreateTable
CREATE TABLE `AppHead` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `kind` ENUM('USER', 'DEPARTMENT') NOT NULL,
    `bitrixId` INTEGER NOT NULL,

    UNIQUE INDEX `AppHead_portalId_kind_bitrixId_key`(`portalId`, `kind`, `bitrixId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AppHead` ADD CONSTRAINT `AppHead_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

