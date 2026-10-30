-- Окно оплаты: свой текст клиенту с вложениями (StoredFile) на одну отправку. Список файлов хранится в
-- заявке: ссылку иногда доводит worker, когда запрос сотрудника уже завершён.
ALTER TABLE `PaymentRequest` ADD COLUMN `messageFileIds` JSON NULL;
