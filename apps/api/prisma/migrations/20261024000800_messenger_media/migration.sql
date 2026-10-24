-- AlterTable
ALTER TABLE `MessengerMessage` ADD COLUMN `mediaId` VARCHAR(40) NULL,
    ADD COLUMN `mediaMime` VARCHAR(150) NULL,
    ADD COLUMN `mediaName` VARCHAR(255) NULL,
    ADD COLUMN `mediaSize` INTEGER NULL;
