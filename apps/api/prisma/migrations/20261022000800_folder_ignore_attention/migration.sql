-- Папка чатов «Не обращать внимания» (решение владельца 2026-10-22): её чаты не попадают в «Требуют внимания».
ALTER TABLE `ChatFolder` ADD COLUMN `ignoreAttention` BOOLEAN NOT NULL DEFAULT false;
