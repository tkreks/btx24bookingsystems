-- Автосообщения приложения клиентам (оплата, подтверждение): не считаются работой сотрудника в «Активности сотрудников».

-- CreateTable
CREATE TABLE `SystemMessage` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `chatId` INTEGER NOT NULL,
    `messageId` INTEGER NULL,
    `userId` INTEGER NULL,
    `source` VARCHAR(32) NOT NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SystemMessage_portalId_sentAt_idx`(`portalId`, `sentAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SystemMessage` ADD CONSTRAINT `SystemMessage_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

