-- CreateTable
CREATE TABLE `Certificate` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `nominal` DECIMAL(14, 2) NOT NULL,
    `holderName` VARCHAR(255) NOT NULL,
    `status` ENUM('new', 'used', 'expired') NOT NULL DEFAULT 'new',
    `paidOn` DATE NULL,
    `validUntil` DATE NOT NULL,
    `dealId` INTEGER NULL,
    `comment` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdByUserId` INTEGER NOT NULL,
    `redeemedAt` DATETIME(3) NULL,

    INDEX `Certificate_portalId_status_validUntil_idx`(`portalId`, `status`, `validUntil`),
    UNIQUE INDEX `Certificate_portalId_number_key`(`portalId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CertificateEvent` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `certificateId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(16) NOT NULL,
    `userId` INTEGER NOT NULL,
    `userName` VARCHAR(255) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `details` JSON NULL,

    INDEX `CertificateEvent_portalId_certificateId_at_idx`(`portalId`, `certificateId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Certificate` ADD CONSTRAINT `Certificate_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CertificateEvent` ADD CONSTRAINT `CertificateEvent_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CertificateEvent` ADD CONSTRAINT `CertificateEvent_certificateId_fkey` FOREIGN KEY (`certificateId`) REFERENCES `Certificate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- Номинал — положительный (сертификат на 0 ₽ не выпускают).
ALTER TABLE `Certificate` ADD CONSTRAINT `Certificate_nominal_positive` CHECK (`nominal` > 0);
