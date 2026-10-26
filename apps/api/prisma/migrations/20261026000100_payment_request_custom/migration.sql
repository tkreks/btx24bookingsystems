-- Ссылка на оплату из встройки сделки: основание, свой срок (часы → минуты) и свой текст клиенту.
-- Хранятся в заявке: ссылку иногда доводит worker, когда запрос сотрудника уже завершён.
ALTER TABLE `PaymentRequest` ADD COLUMN `purpose` VARCHAR(255) NULL,
    ADD COLUMN `timeoutMinutes` INTEGER NULL,
    ADD COLUMN `message` TEXT NULL;
