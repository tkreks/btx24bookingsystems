-- Имя клиента в кэше чатов (контакт/компания/лид CRM): в списке чатов и на дашборде — имя, а не название сделки.
ALTER TABLE `OpenlineChat` ADD COLUMN `clientName` VARCHAR(255) NULL;
