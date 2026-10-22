-- Таблица сессий входа вне портала: миграция 20261022000900_web_sessions ушла без SQL (только комментарий).

-- CreateTable
CREATE TABLE `WebSession` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `userId` INTEGER NOT NULL,
    `userName` VARCHAR(255) NOT NULL,
    `accessTokenEnc` TEXT NOT NULL,
    `refreshTokenEnc` TEXT NOT NULL,
    `accessExpiresAt` DATETIME(3) NOT NULL,
    `oauthHost` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WebSession_tokenHash_key`(`tokenHash`),
    INDEX `WebSession_portalId_userId_idx`(`portalId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WebSession` ADD CONSTRAINT `WebSession_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

