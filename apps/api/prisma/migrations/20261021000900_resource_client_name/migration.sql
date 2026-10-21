-- Альтернативное имя ресурса для сообщений клиенту (в Битрикс24 такого поля нет).
ALTER TABLE `Resource` ADD COLUMN `clientName` VARCHAR(255) NULL;
