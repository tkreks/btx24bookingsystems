-- Сообщений клиента подряд после последнего ответа сотрудника (счётчик «непрочитанных» на дашборде).
ALTER TABLE `OpenlineChat` ADD COLUMN `clientStreak` INTEGER NOT NULL DEFAULT 0;
-- Ждущие ответа чаты до пересчёта сводки: хотя бы одно сообщение клиента.
UPDATE `OpenlineChat` SET `clientStreak` = 1 WHERE `lastAuthor` = 'client';
