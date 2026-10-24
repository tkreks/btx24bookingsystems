-- «!» у чата: общая отметка «важно», снимается сама, когда после неё пишет сотрудник.
ALTER TABLE `OpenlineChat` ADD COLUMN `flagAt` DATETIME(3) NULL,
    ADD COLUMN `flagByName` VARCHAR(255) NULL,
    ADD COLUMN `flagByUserId` INTEGER NULL;
