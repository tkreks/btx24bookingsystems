-- «Не требует ответа» — общая отметка чата для всех сотрудников (решение владельца 2026-10-22).
ALTER TABLE `OpenlineChat` ADD COLUMN `noReplyMessageId` INTEGER NULL,
    ADD COLUMN `noReplyByUserId` INTEGER NULL,
    ADD COLUMN `noReplyByName` VARCHAR(255) NULL,
    ADD COLUMN `noReplyAt` DATETIME(3) NULL;
