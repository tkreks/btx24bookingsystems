-- Реакции на сообщение мессенджера (текущий набор) и имя автора в группе.
ALTER TABLE `MessengerMessage` ADD COLUMN `reactions` JSON NULL,
    ADD COLUMN `authorName` VARCHAR(255) NULL;
