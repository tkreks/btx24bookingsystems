-- AlterTable
ALTER TABLE `MessengerChat` ADD COLUMN `activeDealId` INTEGER NULL,
    ADD COLUMN `crmContactId` INTEGER NULL,
    ADD COLUMN `crmMatch` JSON NULL,
    ADD COLUMN `crmMatchedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `MessengerMessage` ADD COLUMN `awaitingDeal` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `dealId` INTEGER NULL,
    ADD COLUMN `relayChatId` VARCHAR(190) NULL;

-- CreateIndex
CREATE INDEX `MessengerChat_portalId_activeDealId_idx` ON `MessengerChat`(`portalId`, `activeDealId`);

-- CreateIndex
CREATE INDEX `MessengerMessage_portalId_messengerId_chatId_dealId_sentAt_idx` ON `MessengerMessage`(`portalId`, `messengerId`, `chatId`, `dealId`, `sentAt`);

