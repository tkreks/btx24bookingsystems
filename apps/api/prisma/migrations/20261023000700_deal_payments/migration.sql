-- Учёт поступлений оплат по сделкам: «Сумма внесённых оплат» — последняя увиденная и её рост.

-- CreateTable
CREATE TABLE `DealPaidAmount` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `dealId` INTEGER NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `checkedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DealPaidAmount_portalId_dealId_key`(`portalId`, `dealId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DealPayment` (
    `id` VARCHAR(191) NOT NULL,
    `portalId` VARCHAR(191) NOT NULL,
    `dealId` INTEGER NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `total` DECIMAL(14, 2) NOT NULL,
    `at` DATETIME(3) NOT NULL,

    INDEX `DealPayment_portalId_at_idx`(`portalId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DealPaidAmount` ADD CONSTRAINT `DealPaidAmount_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DealPayment` ADD CONSTRAINT `DealPayment_portalId_fkey` FOREIGN KEY (`portalId`) REFERENCES `Portal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
