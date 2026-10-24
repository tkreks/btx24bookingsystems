-- Звонки, исключённые из статистики дашборда (внутренний тест): решение администратора с причиной.
CREATE TABLE `CallExclusion` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `activityId` INTEGER NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `userId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CallExclusion_portalId_activityId_key`(`portalId`, `activityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CallExclusion` ADD CONSTRAINT `CallExclusion_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
-- Причина обязательна (пустая строка — не причина).
ALTER TABLE `CallExclusion` ADD CONSTRAINT `CallExclusion_reason_nonempty` CHECK (CHAR_LENGTH(TRIM(`reason`)) > 0);
