-- Порталы Битрикс24 (тенанты) и журнал входящих событий. Токены хранятся зашифрованными
-- (AES-256-GCM, ключ ENCRYPTION_KEY), application_token — только как sha256-хеш.
-- CreateTable
CREATE TABLE `Portal` (
    `id` VARCHAR(191) NOT NULL,
    `memberId` VARCHAR(64) NOT NULL,
    `domain` VARCHAR(255) NOT NULL,
    `clientEndpoint` VARCHAR(255) NOT NULL,
    `serverEndpoint` VARCHAR(255) NOT NULL,
    `applicationTokenHash` CHAR(64) NULL,
    `accessTokenEnc` TEXT NULL,
    `refreshTokenEnc` TEXT NULL,
    `accessExpiresAt` DATETIME(3) NULL,
    `scope` VARCHAR(1000) NOT NULL DEFAULT '',
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'Europe/Moscow',
    `status` ENUM('ACTIVE', 'UNINSTALLED') NOT NULL DEFAULT 'ACTIVE',
    `installedByUserId` INTEGER NULL,
    `installedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `uninstalledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Portal_memberId_key`(`memberId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Bitrix24Event` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `event` VARCHAR(100) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'PROCESSED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `error` TEXT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,

    INDEX `Bitrix24Event_status_receivedAt_idx`(`status`, `receivedAt`),
    INDEX `Bitrix24Event_portalId_event_idx`(`portalId`, `event`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Bitrix24Event` ADD CONSTRAINT `Bitrix24Event_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
