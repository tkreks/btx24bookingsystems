-- Временные пароли к настройкам (выдаёт администратор приложения; хранится только хеш).
-- CreateTable
CREATE TABLE `SettingsAccessCode` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `codeHash` CHAR(64) NOT NULL,
    `createdByUserId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `usedByUserId` INTEGER NULL,
    `usedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,

    INDEX `SettingsAccessCode_portalId_usedByUserId_expiresAt_idx`(`portalId`, `usedByUserId`, `expiresAt`),
    UNIQUE INDEX `SettingsAccessCode_portalId_codeHash_key`(`portalId`, `codeHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SettingsAccessCode` ADD CONSTRAINT `SettingsAccessCode_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

