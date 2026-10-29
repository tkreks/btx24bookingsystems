-- Вход внешних пользователей по логину и паролю: защита от подбора и сессии.
ALTER TABLE `ExternalUser` ADD COLUMN `failedLogins` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `lastLoginAt` DATETIME(3) NULL,
    ADD COLUMN `lockedUntil` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `ExternalSession` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `externalUserId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ExternalSession_tokenHash_key`(`tokenHash`),
    INDEX `ExternalSession_portalId_externalUserId_idx`(`portalId`, `externalUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ExternalSession` ADD CONSTRAINT `ExternalSession_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExternalSession` ADD CONSTRAINT `ExternalSession_externalUserId_fkey` FOREIGN KEY (`externalUserId`) REFERENCES `ExternalUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
